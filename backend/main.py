"""Consola de Investimentos — aplicação local, single-user.

Backend FastAPI que serve a API e o frontend (consola web local). Local-first:
os dados vivem em SQLite na tua máquina. READ-ONLY: nunca coloca ordens.
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db, config
from .routers import (
    accounts, tracker, lots, perps, scenarios as scenarios_router,
    ppr as ppr_router, settings as settings_router, dashboard,
)

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"

app = FastAPI(title="Consola de Investimentos", version="1.0")


@app.on_event("startup")
def _startup():
    db.init_db()
    db.seed()  # scaffold idempotente (não sobrepõe dados existentes)


for r in (dashboard.router, tracker.router, lots.router, perps.router,
          scenarios_router.router, ppr_router.router, accounts.router,
          settings_router.router):
    app.include_router(r)


@app.get("/api/health")
def health():
    return {"ok": True, "bybit_configured": config.bybit_configured()}


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND), name="static")
