"""
End-to-end remote test:
1. Create job on remote server → get COS presign upload URL
2. Upload test EPUB to COS via presign URL
3. Mark uploaded → job enters queue
4. Worker polls server → downloads EPUB → translates → uploads result → marks complete
5. Poll progress until DONE
6. Get download URL → download result EPUB
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

import httpx

SERVER = "http://122.51.10.98:9001"
TEST_EPUB = os.path.join(os.path.dirname(__file__), "test.epub")
RESULT_PATH = os.path.join(os.path.dirname(__file__), "e2e_result.epub")


def main():
    if not os.path.exists(TEST_EPUB):
        print("❌ test.epub not found. Run create_test_epub.py first.")
        return

    # --- Step 1: Create job ---
    print("=== Step 1: Create job on remote server ===")
    resp = httpx.post(f"{SERVER}/jobs/create", json={
        "deviceId": "e2e-test-device",
        "engineType": "MACHINE",
        "output": "BILINGUAL",
        "sourceLang": "en",
        "targetLang": "zh",
        "sourceFileName": "test.epub",
        "charCount": 500,
    }, timeout=15)
    if resp.status_code != 200:
        print(f"❌ Create failed: {resp.status_code} {resp.text}")
        return
    create_data = resp.json()
    job_id = create_data["jobId"]
    upload_url = create_data["upload"]["url"]
    print(f"  Job ID: {job_id}")
    print(f"  Upload URL: {upload_url[:100]}...")

    # --- Step 2: Upload EPUB to COS ---
    print("\n=== Step 2: Upload EPUB to COS via presign URL ===")
    with open(TEST_EPUB, "rb") as f:
        epub_bytes = f.read()
    resp = httpx.put(
        upload_url,
        content=epub_bytes,
        headers={"Content-Type": "application/epub+zip"},
        timeout=30,
    )
    print(f"  Upload status: {resp.status_code}")
    if resp.status_code >= 300:
        print(f"  ❌ Upload failed: {resp.text[:200]}")
        return
    print("  ✅ EPUB uploaded to COS")

    # --- Step 3: Mark uploaded ---
    print("\n=== Step 3: Mark uploaded ===")
    resp = httpx.post(f"{SERVER}/jobs/markUploaded", json={"jobId": job_id}, timeout=10)
    print(f"  Status: {resp.status_code} {resp.json()}")

    # --- Step 4: Start Worker (import and run one job cycle) ---
    print("\n=== Step 4: Worker processes the job ===")
    # Temporarily point worker at remote server
    os.environ["SERVER_URL"] = SERVER
    os.environ["WORKER_API_KEY"] = ""

    import importlib
    # Need to reload worker module with new SERVER_URL
    if 'worker' in sys.modules:
        del sys.modules['worker']

    # Patch worker's SERVER_URL
    import worker as w
    w.SERVER_URL = SERVER
    w.WORKER_API_KEY = ""

    poll_data = w.api_poll()
    if not poll_data:
        print("  ❌ Worker poll returned nothing!")
        return
    print(f"  Poll returned job: {poll_data['jobId']}")

    if poll_data["jobId"] != job_id:
        print(f"  ⚠️  Got different job {poll_data['jobId']}, processing anyway...")

    w.process_job(poll_data)

    # --- Step 5: Check progress ---
    print("\n=== Step 5: Check progress ===")
    resp = httpx.get(f"{SERVER}/jobs/progress", params={"jobId": job_id}, timeout=10)
    progress = resp.json()
    print(f"  State: {progress.get('state')}")
    print(f"  Percent: {progress.get('percent')}")

    if progress.get("state") != "DONE":
        print(f"  ❌ Expected DONE, got {progress.get('state')}")
        if progress.get("error"):
            print(f"  Error: {progress['error']}")
        return

    # --- Step 6: Download result ---
    print("\n=== Step 6: Download result ===")
    resp = httpx.get(f"{SERVER}/jobs/download", params={"jobId": job_id, "output": "BILINGUAL"}, timeout=10)
    if resp.status_code != 200:
        print(f"  ❌ Download URL failed: {resp.status_code} {resp.text}")
        return
    dl_data = resp.json()
    dl_url = dl_data["url"]
    print(f"  Download URL: {dl_url[:100]}...")

    resp = httpx.get(dl_url, timeout=30, follow_redirects=True)
    if resp.status_code == 200:
        with open(RESULT_PATH, "wb") as f:
            f.write(resp.content)
        print(f"  ✅ Result saved: {RESULT_PATH} ({len(resp.content)} bytes)")
    else:
        print(f"  ❌ Download failed: {resp.status_code}")
        return

    # --- Step 7: Verify job list ---
    print("\n=== Step 7: Verify job list ===")
    resp = httpx.get(f"{SERVER}/jobs/list", params={"deviceId": "e2e-test-device"}, timeout=10)
    jobs = resp.json().get("jobs", [])
    print(f"  Jobs for e2e-test-device: {len(jobs)}")
    for j in jobs:
        s = j.get("progress", {}).get("state", "?")
        print(f"    - {j['jobId'][:16]}... state={s}")

    print("\n🎉 END-TO-END TEST PASSED!")


if __name__ == "__main__":
    main()
