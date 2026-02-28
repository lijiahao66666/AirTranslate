"""
End-to-end local test: bypasses COS, tests the full Worker pipeline
by mocking presign download/upload with local file operations.

Requires: app.js running on localhost:9001
"""
import sys, os, shutil, tempfile, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

import httpx
import epub_util
import translators

SERVER = "http://localhost:9001"
TEST_EPUB = os.path.join(os.path.dirname(__file__), "test.epub")

def main():
    if not os.path.exists(TEST_EPUB):
        print("❌ test.epub not found. Run create_test_epub.py first.")
        return

    # Check server
    try:
        r = httpx.get(f"{SERVER}/health", timeout=5)
        r.raise_for_status()
        print(f"✅ Server is up: {r.json()}")
    except Exception as e:
        print(f"❌ Server not reachable at {SERVER}: {e}")
        return

    # --- Step 1: Create job (will fail COS presign without config, but job is created) ---
    print("\n=== Step 1: Create job ===")
    try:
        resp = httpx.post(f"{SERVER}/jobs/create", json={
            "deviceId": "test-device-001",
            "engineType": "MACHINE",
            "output": "BILINGUAL",
            "sourceLang": "en",
            "targetLang": "zh",
            "sourceFileName": "test.epub",
            "charCount": 500,
        }, timeout=10)
        data = resp.json()
        if resp.status_code != 200:
            print(f"  ⚠️  Create job returned {resp.status_code}: {data}")
            if "COS" in str(data):
                print("  → COS not configured on local server. Testing pipeline without COS...")
                return test_pipeline_no_cos()
            return
        job_id = data["jobId"]
        print(f"  Job created: {job_id}")
        print(f"  Upload URL: {data.get('upload', {}).get('url', 'N/A')[:80]}...")
    except Exception as e:
        print(f"  ❌ Failed: {e}")
        return

    # --- Step 2: Mark uploaded (simulate) ---
    print("\n=== Step 2: Mark uploaded ===")
    resp = httpx.post(f"{SERVER}/jobs/markUploaded", json={"jobId": job_id}, timeout=10)
    print(f"  Status: {resp.status_code} {resp.json()}")

    # --- Step 3: Worker poll ---
    print("\n=== Step 3: Worker poll ===")
    resp = httpx.get(f"{SERVER}/worker/poll", timeout=10)
    poll = resp.json()
    print(f"  Poll result: jobId={poll.get('jobId')}")

    if poll.get("jobId") != job_id:
        print("  ❌ Poll did not return our job!")
        return

    # --- Step 4: Simulate translation (local, without COS download) ---
    print("\n=== Step 4: Local translation pipeline ===")
    job = poll["job"]
    temp_dir = tempfile.mkdtemp(prefix="e2e_test_")
    try:
        # Copy test epub instead of downloading from COS
        source_epub = os.path.join(temp_dir, "source.epub")
        shutil.copy2(TEST_EPUB, source_epub)

        unpack_dir = os.path.join(temp_dir, "unpacked")
        epub_util.unzip_epub(source_epub, unpack_dir)

        html_files = epub_util.find_html_files(unpack_dir)
        print(f"  Found {len(html_files)} HTML files")

        # Update progress
        httpx.post(f"{SERVER}/worker/progress", json={
            "jobId": job_id, "state": "TRANSLATING", "percent": 5,
            "chapterTotal": len(html_files),
        }, timeout=10)

        for i, html_path in enumerate(html_files):
            texts = epub_util.extract_texts(html_path)
            if not texts:
                continue
            print(f"  Translating {os.path.basename(html_path)}: {len(texts)} texts")
            translated = translators.translate_machine(texts, "en", "zh")
            epub_util.write_back(html_path, texts, translated, "BILINGUAL")

            percent = int((i + 1) / len(html_files) * 100)
            httpx.post(f"{SERVER}/worker/progress", json={
                "jobId": job_id, "state": "TRANSLATING", "percent": percent,
                "chapterIndex": i + 1, "chapterTotal": len(html_files),
            }, timeout=10)

        # Repack
        result_epub = os.path.join(temp_dir, "result.epub")
        epub_util.zip_epub(unpack_dir, result_epub)
        print(f"  Result EPUB: {os.path.getsize(result_epub)} bytes")

        # Skip COS upload, just mark complete
        httpx.post(f"{SERVER}/worker/complete", json={"jobId": job_id}, timeout=10)
        print("  ✅ Job marked complete!")

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    # --- Step 5: Check progress ---
    print("\n=== Step 5: Verify progress ===")
    resp = httpx.get(f"{SERVER}/jobs/progress", params={"jobId": job_id}, timeout=10)
    progress = resp.json()
    print(f"  State: {progress.get('state')}")
    print(f"  Percent: {progress.get('percent')}")

    if progress.get("state") == "DONE":
        print("\n✅ END-TO-END TEST PASSED!")
    else:
        print(f"\n❌ Expected DONE, got {progress.get('state')}")

    # --- Step 6: Verify job list ---
    print("\n=== Step 6: Job list ===")
    resp = httpx.get(f"{SERVER}/jobs/list", params={"deviceId": "test-device-001"}, timeout=10)
    jobs = resp.json().get("jobs", [])
    print(f"  Found {len(jobs)} jobs for test-device-001")
    for j in jobs:
        print(f"    - {j.get('jobId', '?')[:16]}... state={j.get('progress', {}).get('state')}")


def test_pipeline_no_cos():
    """Fallback: test translation pipeline directly without server job creation."""
    print("\n=== Fallback: Direct pipeline test (no COS) ===")
    temp_dir = tempfile.mkdtemp(prefix="e2e_nocos_")
    try:
        source_epub = os.path.join(temp_dir, "source.epub")
        shutil.copy2(TEST_EPUB, source_epub)

        unpack_dir = os.path.join(temp_dir, "unpacked")
        epub_util.unzip_epub(source_epub, unpack_dir)

        html_files = epub_util.find_html_files(unpack_dir)
        print(f"  Found {len(html_files)} HTML files")

        for html_path in html_files:
            texts = epub_util.extract_texts(html_path)
            if not texts:
                continue
            fname = os.path.basename(html_path)
            print(f"\n  --- {fname} ---")
            translated = translators.translate_machine(texts, "en", "zh")
            for orig, trans in zip(texts, translated):
                print(f"  EN: {orig}")
                print(f"  ZH: {trans}")
            epub_util.write_back(html_path, texts, translated, "BILINGUAL")

        result_epub = os.path.join(temp_dir, "result.epub")
        epub_util.zip_epub(unpack_dir, result_epub)
        result_size = os.path.getsize(result_epub)

        # Copy result for inspection
        out_path = os.path.join(os.path.dirname(__file__), "test_result.epub")
        shutil.copy2(result_epub, out_path)
        print(f"\n  Result saved to: {out_path} ({result_size} bytes)")
        print("\n✅ PIPELINE TEST PASSED (without COS)!")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
