import os
from functools import lru_cache
from sqlmodel import create_engine, Session

# Use an environment variable with a fallback for local dev
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/osai")

@lru_cache(maxsize=1)
def get_engine():
    try:
        return create_engine(DATABASE_URL, echo=True)
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Database driver is not installed for the configured DATABASE_URL. "
            "Install the dependencies from requirements.txt before using DB-backed APIs."
        ) from exc

def get_session():
    with Session(get_engine()) as session:
        yield session
