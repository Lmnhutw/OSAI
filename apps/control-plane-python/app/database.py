import os
from sqlmodel import create_engine, Session

# Use an environment variable with a fallback for local dev
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/osai")

# Create the synchronous engine for simple execution in phase 1 
# Using psycopg2-binary under the hood
engine = create_engine(DATABASE_URL, echo=True)

def get_session():
    with Session(engine) as session:
        yield session
