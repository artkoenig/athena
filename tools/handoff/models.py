from typing import List, Literal, Optional
from pydantic import BaseModel, Field

class DispatcherHandoff(BaseModel):
    """
    Handoff data for the dispatcher agent. Contains the research results
    and the solution architecture for the subsequent agents.
    """
    technical_specification: str = Field(
        ..., 
        description="Detailed technical specification and solution design based on the acceptance criteria."
    )
    module_map: str = Field(
        ..., 
        description="An overview of the affected modules (file names, paths, contents, and entry points)."
    )
    next_steps: str = Field(
        ..., 
        description="The concrete next steps to be executed by the test-author or implementer."
    )

class TestAuthorHandoff(BaseModel):
    """
    Handoff data for the test-author agent. Documents the written,
    failing tests prior to the actual implementation.
    """
    test_plan: str = Field(
        ..., 
        description="Description of the written tests and the covered criteria."
    )
    coverage_requirements: str = Field(
        ..., 
        description="Details on the covered edge cases and test boundaries."
    )

class ImplementerHandoff(BaseModel):
    """
    Handoff data for the implementer agent. Documents the performed code changes.
    """
    changes_made: str = Field(
        ..., 
        description="Detailed description of the implemented changes and the test results (exit codes)."
    )
    files_modified: List[str] = Field(
        ..., 
        description="List of file paths that were modified during the implementation."
    )

class ReviewerHandoff(BaseModel):
    """
    Handoff data for the reviewer agent. Provides the final verdict on the current iteration cycle.
    """
    status: Literal["approved", "rejected"] = Field(
        ..., 
        description="Status of the review: 'approved' if all tests and criteria are green, 'rejected' if findings were raised."
    )
    findings: Optional[str] = Field(
        None, 
        description="Concrete error descriptions and reproduction steps (input, state, expected vs actual). Must be provided if 'rejected'."
    )
