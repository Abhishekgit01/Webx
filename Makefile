PYTHON ?= python3

.PHONY: setup doctor demo serve test tts clean

setup:
	$(PYTHON) -m pip install -r requirements-dev.txt

doctor:
	$(PYTHON) -m webx doctor

demo:
	$(PYTHON) -m webx demo

serve:
	$(PYTHON) -m webx serve

test:
	$(PYTHON) -m pytest -q

tts:
	$(PYTHON) scripts/generate_tts.py

clean:
	rm -rf artifacts/latest .pytest_cache
