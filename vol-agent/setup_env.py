"""Cria o .env a pedir as chaves da TESTNET. Fica só neste PC."""
print("Chaves da TESTNET (testnet.bybit.com). Colar com botão direito ou Ctrl+V.")
key = input("API key: ").strip()
secret = input("API secret: ").strip()
lev = input("Alavancagem [1]: ").strip() or "1"
cap = input("Teto de alavancagem [10]: ").strip() or "10"
with open(".env", "w", encoding="utf-8") as f:
    f.write(f"BYBIT_API_KEY={key}\nBYBIT_API_SECRET={secret}\nBYBIT_ENV=testnet\n"
            f"BYBIT_LEVERAGE={lev}\nBYBIT_MAX_LEVERAGE={cap}\n")
print(".env criado.")
