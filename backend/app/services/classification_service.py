from __future__ import annotations

import json
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import AppError
from app.db.models import AuditLog, Email, SentimentTrend, Thread
from app.schemas.classification import ClassificationResponse, SentimentTrendPoint
from app.services.knowledge_service import KnowledgeService
from app.services.priority_service import score_email


SENTIMENT_BY_LABEL = {
    "Positive": Decimal("0.65"),
    "Neutral": Decimal("0.00"),
    "Negative": Decimal("-0.65"),
    "Mixed": Decimal("-0.20"),
}


class ClassificationService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.settings = get_settings()
        self.knowledge = KnowledgeService(db)

    def classify_email(self, email_id: UUID) -> ClassificationResponse:
        email = self.db.get(Email, email_id)
        if email is None:
            raise AppError(
                status_code=404,
                error_code="EMAIL_NOT_FOUND",
                message="Email was not found.",
                details={"email_id": str(email_id)},
            )

        thread_history = self._thread_history(email.thread_id)
        rag_chunks = self.knowledge.search(f"{email.subject or ''} {email.body or ''}", top_k=4)
        prompt = self._build_prompt(email, thread_history, rag_chunks)
        raw = self._classify_with_gemini(prompt) or self._classify_locally(email, rag_chunks)
        classification = self._normalize_classification(raw, email, rag_chunks)

        old_values = {
            "category": email.category,
            "sentiment": email.sentiment,
            "urgency": email.urgency,
            "confidence": float(email.confidence) if email.confidence is not None else None,
            "requires_human": email.requires_human,
        }
        self._apply_classification(email, classification, prompt, rag_chunks)
        self._refresh_sender_sentiment(email.sender)
        self._audit(email, old_values, classification)
        self.db.commit()

        return self._response(email, classification)

    def get_sentiment_trend(self, sender_email: str | None, days: int) -> list[SentimentTrendPoint]:
        query = select(SentimentTrend).where(SentimentTrend.date >= datetime.utcnow().date() - timedelta(days=days))
        if sender_email:
            query = query.where(SentimentTrend.sender_email == sender_email)
        rows = self.db.execute(query.order_by(SentimentTrend.date.asc())).scalars().all()
        return [
            SentimentTrendPoint(
                sender_email=row.sender_email,
                date=row.date,
                avg_sentiment=float(row.avg_sentiment) if row.avg_sentiment is not None else None,
                min_sentiment=float(row.min_sentiment) if row.min_sentiment is not None else None,
                max_sentiment=float(row.max_sentiment) if row.max_sentiment is not None else None,
                email_count=row.email_count,
                moving_avg_7d=float(row.moving_avg_7d) if row.moving_avg_7d is not None else None,
                moving_avg_30d=float(row.moving_avg_30d) if row.moving_avg_30d is not None else None,
            )
            for row in rows
        ]

    def _thread_history(self, thread_pk: UUID) -> list[dict[str, Any]]:
        rows = self.db.execute(
            select(Email)
            .where(Email.thread_id == thread_pk)
            .order_by(Email.timestamp.asc())
            .limit(20)
        ).scalars()
        return [
            {
                "message_id": row.message_id,
                "sender": row.sender,
                "subject": row.subject,
                "body": (row.body or "")[:1200],
                "sentiment": row.sentiment,
                "urgency": row.urgency,
                "timestamp": row.timestamp.isoformat(),
            }
            for row in rows
        ]

    def _build_prompt(
        self,
        email: Email,
        thread_history: list[dict[str, Any]],
        rag_chunks: list[dict[str, Any]],
    ) -> str:
        return json.dumps(
            {
                "role": "SenAI support classification engine",
                "instruction": (
                    "Return valid JSON only. Cite policy documents when drafting replies. "
                    "Resolve conflicts by prioritizing security/legal risk, explicit deadlines, "
                    "thread sentiment trend, and then the latest email tone."
                ),
                "schema": {
                    "category": "Complaint|Inquiry|Bug Report|Feature Request|Compliance|Legal|Billing|Spam|Internal|Other",
                    "sentiment": "Positive|Neutral|Negative|Mixed",
                    "sentiment_score": "float -1.0 to 1.0",
                    "urgency": "Critical|High|Medium|Low",
                    "requires_human": "boolean",
                    "escalation_reason": "string|null",
                    "suggested_reply": "string with policy citation",
                    "confidence": "float 0.0 to 1.0",
                    "detected_entities": "object",
                    "policy_citations": "array",
                },
                "email": {
                    "message_id": email.message_id,
                    "sender": email.sender,
                    "subject": email.subject,
                    "body": email.body,
                    "timestamp": email.timestamp.isoformat(),
                },
                "thread_history": thread_history,
                "rag_chunks": rag_chunks,
            },
            default=str,
        )

    def _classify_with_gemini(self, prompt: str) -> dict[str, Any] | None:
        if not self.settings.gemini_api_key:
            return None
        try:
            import google.generativeai as genai

            genai.configure(api_key=self.settings.gemini_api_key)
            model = genai.GenerativeModel(self.settings.gemini_model)
            response = model.generate_content(
                prompt,
                generation_config=genai.types.GenerationConfig(temperature=0.2, max_output_tokens=1200),
            )
            response_text = response.text.strip()
            start = response_text.find("{")
            end = response_text.rfind("}") + 1
            if start == -1 or end <= start:
                return None
            return json.loads(response_text[start:end])
        except Exception:
            return None

    def _classify_locally(self, email: Email, rag_chunks: list[dict[str, Any]]) -> dict[str, Any]:
        heuristic = score_email(email.sender, email.subject or "", email.body or "")
        text = f"{email.subject or ''} {email.body or ''}".lower()
        negative = any(word in text for word in ["angry", "unhappy", "terrible", "worst", "frustrated", "lawsuit"])
        positive = any(word in text for word in ["thanks", "love", "great", "helpful", "appreciate"])
        sentiment = "Negative" if negative else "Positive" if positive else "Neutral"
        confidence = heuristic.confidence
        if negative and positive:
            sentiment = "Mixed"
            confidence = min(confidence, 0.68)

        citation = KnowledgeService.citations(rag_chunks[:1])
        cited_doc = citation[0]["document"] if citation else "SenAI policy"
        return {
            "category": heuristic.category,
            "sentiment": sentiment,
            "sentiment_score": float(SENTIMENT_BY_LABEL[sentiment]),
            "urgency": heuristic.urgency,
            "requires_human": heuristic.requires_human,
            "escalation_reason": None,
            "suggested_reply": f"Thanks for contacting SenAI. We reviewed your request against {cited_doc} and will follow up with the next step.",
            "confidence": confidence,
            "detected_entities": heuristic.entities,
            "policy_citations": citation,
        }

    def _normalize_classification(
        self,
        data: dict[str, Any],
        email: Email,
        rag_chunks: list[dict[str, Any]],
    ) -> dict[str, Any]:
        heuristic = score_email(email.sender, email.subject or "", email.body or "")
        category = self._pick(data.get("category"), {"Complaint", "Inquiry", "Bug Report", "Feature Request", "Compliance", "Legal", "Billing", "Spam", "Internal", "Other"}, heuristic.category)
        sentiment = self._pick(data.get("sentiment"), {"Positive", "Neutral", "Negative", "Mixed"}, "Neutral")
        urgency = self._pick(data.get("urgency"), {"Critical", "High", "Medium", "Low"}, heuristic.urgency)
        confidence = self._bounded_float(data.get("confidence"), 0.75, 0.0, 1.0)
        requires_human = bool(data.get("requires_human", False))
        escalation_reason = data.get("escalation_reason")
        conflict_notes = []

        if heuristic.is_security_alert or heuristic.is_legal_threat:
            requires_human = True
            urgency = "Critical"
            escalation_reason = escalation_reason or "Security/legal signal overrides softer sentiment."
            conflict_notes.append("security/legal signal prioritized")
        if confidence < self.settings.classification_confidence_floor:
            requires_human = True
            escalation_reason = escalation_reason or "Classification confidence below 0.70."
            conflict_notes.append("low confidence routed to human")
        if self._has_three_consecutive_negatives(email.sender, email.id, sentiment):
            requires_human = True
            urgency = "High" if urgency in {"Low", "Medium"} else urgency
            escalation_reason = escalation_reason or "Three consecutive negative messages from sender."
            conflict_notes.append("negative sentiment streak escalated")

        citations = data.get("policy_citations") or KnowledgeService.citations(rag_chunks[:2])
        return {
            "category": category,
            "sentiment": sentiment,
            "sentiment_score": self._bounded_decimal(data.get("sentiment_score"), SENTIMENT_BY_LABEL[sentiment], Decimal("-1.00"), Decimal("1.00")),
            "urgency": urgency,
            "requires_human": requires_human,
            "escalation_reason": escalation_reason,
            "suggested_reply": str(data.get("suggested_reply") or "Thanks for contacting SenAI. We are reviewing this and will follow up shortly."),
            "confidence": Decimal(str(round(confidence, 2))),
            "detected_entities": data.get("detected_entities") or heuristic.entities,
            "policy_citations": citations,
            "conflict_resolution": "; ".join(conflict_notes) or "No conflicting signals detected.",
        }

    def _apply_classification(self, email: Email, classification: dict[str, Any], prompt: str, rag_chunks: list[dict[str, Any]]) -> None:
        email.category = classification["category"]
        email.sentiment = classification["sentiment"]
        email.sentiment_score = classification["sentiment_score"]
        email.urgency = classification["urgency"]
        email.confidence = classification["confidence"]
        email.requires_human = classification["requires_human"]
        email.status = "Escalated" if email.requires_human and email.urgency == "Critical" else "Processing"
        email.raw_entities = {
            **(email.raw_entities or {}),
            "classification": {
                "prompt_contract": json.loads(prompt),
                "suggested_reply": classification["suggested_reply"],
                "escalation_reason": classification["escalation_reason"],
                "detected_entities": classification["detected_entities"],
                "policy_citations": classification["policy_citations"],
                "conflict_resolution": classification["conflict_resolution"],
                "rag_chunks_used": rag_chunks,
            },
        }
        thread = self.db.get(Thread, email.thread_id)
        if thread:
            thread.priority = classification["urgency"]
            if email.requires_human:
                thread.status = "Escalated"

    def _refresh_sender_sentiment(self, sender_email: str) -> None:
        dates = self.db.execute(
            select(func.date(Email.timestamp))
            .where(Email.sender == sender_email, Email.sentiment_score.is_not(None))
            .group_by(func.date(Email.timestamp))
        ).scalars().all()
        for day in dates:
            start = datetime.combine(day, datetime.min.time())
            end = start + timedelta(days=1)
            aggregate = self.db.execute(
                select(
                    func.avg(Email.sentiment_score),
                    func.min(Email.sentiment_score),
                    func.max(Email.sentiment_score),
                    func.count(Email.id),
                ).where(Email.sender == sender_email, Email.timestamp >= start, Email.timestamp < end)
            ).one()
            moving_7d = self._moving_average(sender_email, day, 7)
            moving_30d = self._moving_average(sender_email, day, 30)
            stmt = insert(SentimentTrend).values(
                sender_email=sender_email,
                date=day,
                avg_sentiment=aggregate[0],
                min_sentiment=aggregate[1],
                max_sentiment=aggregate[2],
                email_count=aggregate[3],
                moving_avg_7d=moving_7d,
                moving_avg_30d=moving_30d,
            )
            self.db.execute(
                stmt.on_conflict_do_update(
                    index_elements=["sender_email", "date"],
                    set_={
                        "avg_sentiment": stmt.excluded.avg_sentiment,
                        "min_sentiment": stmt.excluded.min_sentiment,
                        "max_sentiment": stmt.excluded.max_sentiment,
                        "email_count": stmt.excluded.email_count,
                        "moving_avg_7d": stmt.excluded.moving_avg_7d,
                        "moving_avg_30d": stmt.excluded.moving_avg_30d,
                    },
                )
            )

    def _moving_average(self, sender_email: str, day: Any, window_days: int) -> Decimal | None:
        start = datetime.combine(day - timedelta(days=window_days - 1), datetime.min.time())
        end = datetime.combine(day + timedelta(days=1), datetime.min.time())
        value = self.db.execute(
            select(func.avg(Email.sentiment_score)).where(
                Email.sender == sender_email,
                Email.timestamp >= start,
                Email.timestamp < end,
                Email.sentiment_score.is_not(None),
            )
        ).scalar_one()
        return value

    def _has_three_consecutive_negatives(self, sender: str, current_email_id: UUID, current_sentiment: str) -> bool:
        sentiments = [
            row.sentiment
            for row in self.db.execute(
                select(Email)
                .where(Email.sender == sender)
                .order_by(Email.timestamp.desc())
                .limit(3)
            ).scalars()
        ]
        if current_sentiment and (not sentiments or sentiments[0] is None):
            sentiments = [current_sentiment, *sentiments[1:]]
        return len(sentiments) >= 3 and all(item == "Negative" for item in sentiments[:3])

    def _audit(self, email: Email, old_values: dict[str, Any], classification: dict[str, Any]) -> None:
        self.db.add(
            AuditLog(
                entity_type="email",
                entity_id=email.id,
                action="CLASSIFIED",
                performed_by="classification_engine",
                old_values=old_values,
                new_values=classification,
            )
        )

    def _response(self, email: Email, classification: dict[str, Any]) -> ClassificationResponse:
        return ClassificationResponse(
            email_id=email.id,
            category=classification["category"],
            sentiment=classification["sentiment"],
            sentiment_score=float(classification["sentiment_score"]),
            urgency=classification["urgency"],
            requires_human=classification["requires_human"],
            escalation_reason=classification["escalation_reason"],
            suggested_reply=classification["suggested_reply"],
            confidence=float(classification["confidence"]),
            detected_entities=classification["detected_entities"],
            policy_citations=classification["policy_citations"],
            conflict_resolution=classification["conflict_resolution"],
        )

    @staticmethod
    def _pick(value: Any, allowed: set[str], default: str) -> str:
        return value if isinstance(value, str) and value in allowed else default

    @staticmethod
    def _bounded_float(value: Any, default: float, low: float, high: float) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            parsed = default
        return min(high, max(low, parsed))

    @classmethod
    def _bounded_decimal(cls, value: Any, default: Decimal, low: Decimal, high: Decimal) -> Decimal:
        try:
            parsed = Decimal(str(value))
        except Exception:
            parsed = default
        return min(high, max(low, parsed.quantize(Decimal("0.01"))))
