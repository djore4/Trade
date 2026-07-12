.PHONY: dev install seed test clean

# Arranca a consola (um comando). Abre em http://127.0.0.1:8000
dev:
	python3 -m uvicorn backend.main:app --reload --host $${HOST:-127.0.0.1} --port $${PORT:-8000}

install:
	python3 -m pip install -r requirements.txt

# Recria a base de dados com o scaffold de contas/ativos (sem valores inventados)
seed:
	python3 -m backend.db --seed

test:
	python3 -m pytest -q

clean:
	rm -f data/*.db data/*.db-wal data/*.db-shm
