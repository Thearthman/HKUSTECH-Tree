"""Run the HKUST course-tree service on the local machine."""

from __future__ import annotations

import os

from hkust_tree.server import create_app


def main() -> None:
    host = os.environ.get("HKUST_TREE_HOST", "127.0.0.1")
    port = int(os.environ.get("HKUST_TREE_PORT", "5000"))
    create_app().run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()
