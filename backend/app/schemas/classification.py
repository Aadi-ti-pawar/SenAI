from datetime import date, datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class ClassificationResponse(BaseModel):
    email_id: UUID
    category: str
    sentiment: str
    sentiment_score: float
    urgency: str
    requires_human: bool
    escalation_reason: str | None = None
    suggested_reply: str
    confidence: float
    detected_entities: dict[str, Any] = Field(default_factory=dict)
    policy_citations: list[dict[str, Any]] = Field(default_factory=list)
    conflict_resolution: str


class SentimentTrendPoint(BaseModel):
    sender_email: str
    date: date
    avg_sentiment: float | None
    min_sentiment: float | None
    max_sentiment: float | None
    email_count: int
    moving_avg_7d: float | None
    moving_avg_30d: float | None


class AgentDecisionResponse(BaseModel):
    email_id: UUID
    action_id: UUID | None = None
    action_type: str
    recommended_action: str
    confidence: float
    dry_run: bool
    tool_calls_used: int
    reasoning_steps: list[dict[str, Any]]
    proposed_content: str | None = None
    rag_citations: list[dict[str, Any]] = Field(default_factory=list)
    created_at: datetime | None = None
