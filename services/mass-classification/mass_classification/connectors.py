"""Explicitly configured source adapters. Polling can run via a scheduler or Kafka consumer."""
import argparse
import io
import json
from pathlib import Path
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def submit(base_url: str, api_key: str, filename: str, data: bytes, source: dict):
    """Send to a trusted Mass Classification instance; never embed source credentials in metadata."""
    import httpx
    if not base_url.startswith(("https://", "http://127.0.0.1:", "http://localhost:")):
        raise ValueError("HTTPS required for remote API")
    with httpx.Client(timeout=120) as client:
        response = client.post(base_url.rstrip("/") + "/v1/documents",
                               headers={"Authorization": f"Bearer {api_key}"},
                               files={"file": (filename, data)}, data={"source_json": json.dumps(source)})
        response.raise_for_status()
        return response.json()


def records(config: dict):
    kind = config["kind"]
    if kind == "files":
        for path in Path(config["directory"]).glob(config.get("glob", "*")):
            if path.is_file():
                yield path.name, path.read_bytes(), {"connector": kind, "path": str(path)}
    elif kind == "rss":
        import feedparser
        for url in config["urls"]:
            if not url.startswith("https://"):
                raise ValueError("RSS feeds require HTTPS")
            parsed = feedparser.parse(url)
            for entry in parsed.entries:
                text = f"{entry.get('title', '')}\n{entry.get('summary', '')}"
                yield f"feed-{entry.get('id', entry.get('link', 'entry'))[-60:]}.txt", text.encode(), {
                    "connector": kind, "feed": url, "url": entry.get("link"), "published": entry.get("published")}
    elif kind == "s3":
        import boto3
        bucket = config["bucket"]
        client = boto3.client("s3", endpoint_url=config.get("endpoint_url"))
        for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=config.get("prefix", "")):
            for obj in page.get("Contents", []):
                if obj["Size"] <= config.get("max_bytes", 50_000_000):
                    key = obj["Key"]
                    yield Path(key).name, client.get_object(Bucket=bucket, Key=key)["Body"].read(), {
                        "connector": kind, "bucket": bucket, "key": key}
    elif kind == "sql":
        import psycopg
        # Query and connection string belong to operator-managed config, never to API callers.
        if not config["query"].lstrip().lower().startswith("select "):
            raise ValueError("SQL adapter requires SELECT")
        with psycopg.connect(config["dsn"], autocommit=True) as conn:
            with conn.cursor(name="mass_source") as cursor:
                cursor.execute(config["query"])
                for i, row in enumerate(cursor):
                    yield f"row-{i}.json", json.dumps(row, default=str).encode(), {"connector": kind, "row": i}
    elif kind == "mongodb":
        from pymongo import MongoClient
        with MongoClient(config["uri"]) as client:
            collection = client[config["database"]][config["collection"]]
            for row in collection.find(config.get("filter", {}), limit=config.get("limit", 1000)):
                yield f"mongo-{row['_id']}.json", json.dumps(row, default=str).encode(), {"connector": kind, "id": str(row["_id"])}
    elif kind == "sftp":
        import paramiko
        ssh = paramiko.SSHClient(); ssh.load_system_host_keys(); ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
        ssh.connect(config["host"], username=config["username"], key_filename=config["key_filename"])
        try:
            with ssh.open_sftp() as sftp:
                for name in sftp.listdir(config["directory"]):
                    remote = config["directory"].rstrip("/") + "/" + name
                    if sftp.stat(remote).st_size <= config.get("max_bytes", 50_000_000):
                        with sftp.open(remote, "rb") as stream:
                            yield name, stream.read(), {"connector": kind, "remote": remote}
        finally:
            ssh.close()
    elif kind == "kafka":
        from kafka import KafkaConsumer
        consumer = KafkaConsumer(config["topic"], bootstrap_servers=config["bootstrap_servers"],
                                 group_id=config["group_id"], enable_auto_commit=False,
                                 consumer_timeout_ms=config.get("timeout_ms", 10000))
        try:
            for msg in consumer:
                # Offset is committed after successful API receipt; duplicates are deduped by hash.
                yield f"kafka-{msg.partition}-{msg.offset}.json", msg.value, {
                    "connector": kind, "topic": msg.topic, "partition": msg.partition, "offset": msg.offset}
                consumer.commit()
        finally:
            consumer.close()
    else:
        raise ValueError(f"Unknown connector: {kind}")


def main():
    import os
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--api", required=True)
    args = parser.parse_args()
    token = os.environ["MASS_API_KEY"]
    config = json.loads(Path(args.config).read_text())
    for filename, data, source in records(config):
        result = submit(args.api, token, filename, data, source)
        print(json.dumps({"file": filename, "id": result["id"], "duplicate": result["duplicate"]}))


if __name__ == "__main__":
    main()
