FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr ffmpeg libmagic1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
COPY mass_classification ./mass_classification
COPY migrations ./migrations
RUN pip install --no-cache-dir ".[topology]" && python -m spacy download xx_ent_wiki_sm
RUN useradd -u 10001 -m mass && mkdir -p /var/lib/mass && chown -R mass:mass /var/lib/mass
USER mass
EXPOSE 8000
CMD ["uvicorn", "mass_classification.api:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
