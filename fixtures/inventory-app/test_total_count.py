import unittest
from http.server import HTTPServer
from threading import Thread
from urllib.request import urlopen

from server import Handler


class TotalCountTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def fetch_page(self):
        with urlopen(f"http://127.0.0.1:{self.port}/") as resp:
            return resp.read().decode()

    def test_total_count_status_line_is_present(self):
        html = self.fetch_page()
        self.assertIn('data-testid="total-count"', html)
        self.assertIn("10 items total", html)


if __name__ == "__main__":
    unittest.main()
