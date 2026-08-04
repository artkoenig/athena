from pydantic import BaseModel
from typing import List, Optional

class BaseHandoff(BaseModel):
    pass

class DispatcherHandoff(BaseHandoff):
    technical_specification: str
    module_map: str
    next_steps: str

class TestAuthorHandoff(BaseHandoff):
    test_plan: str
    coverage_requirements: str

class ImplementerHandoff(BaseHandoff):
    changes_made: str
    files_modified: List[str]

class ReviewerHandoff(BaseHandoff):
    status: str
    findings: str
