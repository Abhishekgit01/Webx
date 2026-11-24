PYTHON ?= python3

.PHONY: setup doctor demo serve test tts clean

setup:
	$(PYTHON) -m pip install -r requirements-dev.txt

doctor:
	$(PYTHON) -m aegisweb doctor

demo:
	$(PYTHON) -m aegisweb demo

serve:
	$(PYTHON) -m aegisweb serve

test:
	$(PYTHON) -m pytest -q

tts:
	$(PYTHON) scripts/generate_tts.py

clean:
	rm -rf artifacts/latest .pytest_cache
