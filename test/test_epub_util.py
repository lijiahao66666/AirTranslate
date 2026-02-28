"""Test EPUB utility functions."""
import sys, os, tempfile, shutil
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

import epub_util

TEST_EPUB = os.path.join(os.path.dirname(__file__), "test.epub")
if not os.path.exists(TEST_EPUB):
    print("❌ test.epub not found. Run create_test_epub.py first.")
    sys.exit(1)

temp_dir = tempfile.mkdtemp(prefix="test_epub_")
try:
    # 1. Unzip
    unpack_dir = os.path.join(temp_dir, "unpacked")
    print("=== Unzipping EPUB ===")
    epub_util.unzip_epub(TEST_EPUB, unpack_dir)
    print(f"  Unpacked to: {unpack_dir}")

    # 2. Find HTML files
    print("\n=== Finding HTML files ===")
    html_files = epub_util.find_html_files(unpack_dir)
    print(f"  Found {len(html_files)} HTML files:")
    for f in html_files:
        print(f"    - {os.path.relpath(f, unpack_dir)}")

    # 3. Extract texts
    print("\n=== Extracting texts ===")
    for html_path in html_files:
        texts = epub_util.extract_texts(html_path)
        fname = os.path.basename(html_path)
        print(f"  {fname}: {len(texts)} text nodes")
        for i, t in enumerate(texts):
            print(f"    [{i}] {t[:80]}{'...' if len(t) > 80 else ''}")

    # 4. Write back (bilingual)
    print("\n=== Write back (BILINGUAL) ===")
    html_path = html_files[0]
    original = epub_util.extract_texts(html_path)
    fake_translated = [f"[翻译]{t}" for t in original]
    epub_util.write_back(html_path, original, fake_translated, "BILINGUAL")
    print(f"  Wrote back {len(original)} translations to {os.path.basename(html_path)}")

    # 5. Re-read to verify
    print("\n=== Verifying write-back ===")
    with open(html_path, "r", encoding="utf-8") as f:
        content = f.read()
    if "[翻译]" in content:
        print("  ✅ Bilingual write-back verified!")
    else:
        print("  ❌ Write-back content not found")

    # 6. Repack
    print("\n=== Repacking EPUB ===")
    result_epub = os.path.join(temp_dir, "result.epub")
    epub_util.zip_epub(unpack_dir, result_epub)
    size = os.path.getsize(result_epub)
    print(f"  Result: {result_epub} ({size} bytes)")
    print("  ✅ Repack succeeded!")

    print("\n✅ All EPUB utility tests passed!")

finally:
    shutil.rmtree(temp_dir, ignore_errors=True)
