import importlib
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))


@pytest.fixture()
def api(monkeypatch):
    """API nueva con base de datos temporal en cada prueba (el lifespan crea tablas y cuenta demo)."""
    d = tempfile.mkdtemp()
    monkeypatch.setenv("SAFERIDE_DB", os.path.join(d, "t.db"))
    monkeypatch.setenv("SAFERIDE_SECRET", "secreto-de-pruebas")
    monkeypatch.setenv("SAFERIDE_DEMO", "1")
    sys.modules.pop("main", None)
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient

    with TestClient(main.app) as client:
        client.main = main
        yield client
