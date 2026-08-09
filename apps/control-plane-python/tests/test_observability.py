import unittest

from fastapi.testclient import TestClient

from main import app


class ObservabilityTests(unittest.TestCase):
    def test_health_response_carries_request_id_and_metrics(self):
        with TestClient(app) as client:
            response = client.get("/health", headers={"X-Request-ID": "request-under-test"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["X-Request-ID"], "request-under-test")
            metrics = client.get("/metrics")
            self.assertEqual(metrics.status_code, 200)
            self.assertIn("osai_http_requests_total", metrics.text)
            self.assertIn('route="/health"', metrics.text)


if __name__ == "__main__":
    unittest.main()
