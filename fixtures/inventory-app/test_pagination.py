import json
import unittest
from http.server import HTTPServer
from threading import Thread
from urllib.request import urlopen

from server import Handler, ITEMS, PAGE_SIZE


class PaginationTestCase(unittest.TestCase):
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

    def fetch_items(self, page):
        with urlopen(f"http://127.0.0.1:{self.port}/api/items?page={page}") as resp:
            return json.loads(resp.read().decode())

    def test_next_shows_item_6_on_page_2(self):
        data = self.fetch_items(2)
        self.assertEqual(data["page"], 2)
        self.assertEqual(data["pages"], 2)
        self.assertEqual(data["items"][0], "Item 6")

    def test_previous_restores_item_1_on_page_1(self):
        data = self.fetch_items(1)
        self.assertEqual(data["page"], 1)
        self.assertEqual(data["pages"], 2)
        self.assertEqual(data["items"][0], "Item 1")


if __name__ == "__main__":
    unittest.main()
