from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session


@dataclass(frozen=True)
class KnowledgeChunk:
    document: str
    section: str
    content: str
    similarity: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "document": self.document,
            "section": self.section,
            "content": self.content,
            "similarity": self.similarity,
        }


class KnowledgeService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def search(self, query: str, top_k: int = 3) -> list[dict[str, Any]]:
        terms = [term for term in re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,}", query.lower()) if term]
        if not terms:
            terms = ["policy"]

        clauses = []
        params: dict[str, Any] = {"limit": top_k}
        for index, term in enumerate(terms[:8]):
            key = f"term_{index}"
            clauses.append(f"LOWER(chunk_text) LIKE :{key}")
            params[key] = f"%{term}%"

        where_sql = " OR ".join(clauses)
        rows = self.db.execute(
            text(
                f"""
                SELECT source_doc,
                       COALESCE(metadata->>'section', source_doc) AS section,
                       chunk_text
                FROM knowledge_chunks
                WHERE {where_sql}
                ORDER BY updated_at DESC
                LIMIT :limit
                """
            ),
            params,
        ).mappings()

        results: list[dict[str, Any]] = []
        for row in rows:
            content = row["chunk_text"]
            score = self._keyword_score(content, terms)
            results.append(
                KnowledgeChunk(
                    document=row["source_doc"],
                    section=row["section"],
                    content=content,
                    similarity=score,
                ).as_dict()
            )

        return sorted(results, key=lambda item: item["similarity"], reverse=True)

    @staticmethod
    def citations(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "document": chunk.get("document"),
                "section": chunk.get("section"),
                "similarity": chunk.get("similarity"),
            }
            for chunk in chunks
        ]

    @staticmethod
    def _keyword_score(content: str, terms: list[str]) -> float:
        lowered = content.lower()
        hits = sum(1 for term in terms if term in lowered)
        return round(min(0.99, 0.45 + hits / max(len(terms), 1) * 0.5), 2)
