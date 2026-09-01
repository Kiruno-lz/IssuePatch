# Pagination is stuck on the first page

On the inventory page, click **Next**.

The page indicator changes to page 2, but the visible inventory rows still show items 1–5. Users expect page 2 to show items 6–10 and the indicator to read `Page 2 of 2`.

Acceptance criteria:

- clicking the button labelled `Next` changes the visible first item to `Item 6`;
- the page indicator is `Page 2 of 2`;
- the existing first-page behaviour still works after returning with `Previous`.
