from datetime import datetime
from uuid import UUID

from app.db.models import ProcessingJob
from app.db.session import SessionLocal
from app.services.agent_service import TriageAgentService
from app.services.classification_service import ClassificationService
from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.tasks.process_ingested_email")
def process_ingested_email(job_id: str) -> dict[str, str]:
    db = SessionLocal()
    try:
        job = db.get(ProcessingJob, UUID(job_id))
        if job is None:
            return {"status": "missing", "job_id": job_id}

        job.status = "Processing"
        job.progress_percentage = 10
        job.started_at = datetime.utcnow()
        db.commit()

        classification = ClassificationService(db).classify_email(job.email_id)
        job.progress_percentage = 55
        job.result_data = {
            **(job.result_data or {}),
            "classification": classification.model_dump(mode="json"),
        }
        db.commit()

        agent = TriageAgentService(db).run(job.email_id, dry_run=False)
        job.progress_percentage = 90
        job.result_data = {
            **(job.result_data or {}),
            "agent": agent.model_dump(mode="json"),
        }
        db.commit()

        job.status = "Completed"
        job.progress_percentage = 100
        job.completed_at = datetime.utcnow()
        job.result_data = {
            **(job.result_data or {}),
            "worker": "classification_and_triage",
            "completed_stage": "agent_decision",
        }
        db.commit()
        return {"status": "completed", "job_id": job_id}
    except Exception as exc:
        db.rollback()
        job = db.get(ProcessingJob, UUID(job_id))
        if job is not None:
            job.status = "Failed"
            job.error_message = str(exc)
            job.completed_at = datetime.utcnow()
            db.commit()
        raise
    finally:
        db.close()
