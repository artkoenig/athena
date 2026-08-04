import unittest

class TestHandoffModels(unittest.TestCase):
    def test_models_exist(self):
        try:
            from tools.handoff.models import DispatcherHandoff, ImplementerHandoff, ReviewerHandoff, TestAuthorHandoff
        except ImportError as e:
            self.fail(f"Could not import Pydantic models: {e}")

    def test_models_inherit_pydantic(self):
        try:
            from pydantic import BaseModel
            from tools.handoff.models import DispatcherHandoff, ImplementerHandoff, ReviewerHandoff, TestAuthorHandoff
            
            self.assertTrue(issubclass(DispatcherHandoff, BaseModel))
            self.assertTrue(issubclass(ImplementerHandoff, BaseModel))
            self.assertTrue(issubclass(ReviewerHandoff, BaseModel))
            self.assertTrue(issubclass(TestAuthorHandoff, BaseModel))
        except ImportError:
            self.fail("pydantic is not installed or models do not inherit from BaseModel")

    def test_dispatcher_fields(self):
        try:
            from tools.handoff.models import DispatcherHandoff
            fields = DispatcherHandoff.model_fields if hasattr(DispatcherHandoff, 'model_fields') else DispatcherHandoff.__annotations__
            self.assertIn("technical_specification", fields)
            self.assertIn("module_map", fields)
            self.assertIn("next_steps", fields)
        except ImportError:
            self.fail("DispatcherHandoff not found")

    def test_test_author_fields(self):
        try:
            from tools.handoff.models import TestAuthorHandoff
            fields = TestAuthorHandoff.model_fields if hasattr(TestAuthorHandoff, 'model_fields') else TestAuthorHandoff.__annotations__
            self.assertIn("test_plan", fields)
            self.assertIn("coverage_requirements", fields)
        except ImportError:
            self.fail("TestAuthorHandoff not found")

    def test_implementer_fields(self):
        try:
            from tools.handoff.models import ImplementerHandoff
            fields = ImplementerHandoff.model_fields if hasattr(ImplementerHandoff, 'model_fields') else ImplementerHandoff.__annotations__
            self.assertIn("changes_made", fields)
            self.assertIn("files_modified", fields)
        except ImportError:
            self.fail("ImplementerHandoff not found")

    def test_reviewer_fields(self):
        try:
            from tools.handoff.models import ReviewerHandoff
            fields = ReviewerHandoff.model_fields if hasattr(ReviewerHandoff, 'model_fields') else ReviewerHandoff.__annotations__
            self.assertIn("status", fields)
            self.assertIn("findings", fields)
        except ImportError:
            self.fail("ReviewerHandoff not found")

if __name__ == '__main__':
    unittest.main()
