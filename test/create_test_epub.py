"""Create a minimal test EPUB file for end-to-end testing."""
import os
import zipfile

OUT = os.path.join(os.path.dirname(__file__), "test.epub")

MIMETYPE = "application/epub+zip"

CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""

CONTENT_OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="uid">test-book-001</dc:identifier>
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>"""

CHAPTER1 = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
<h1>The Beginning</h1>
<p>Once upon a time, there was a small village at the foot of a great mountain.</p>
<p>The villagers lived peaceful lives, farming the fertile land and trading with nearby towns.</p>
<p>One day, a mysterious stranger arrived at the village gate.</p>
</body>
</html>"""

CHAPTER2 = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 2</title></head>
<body>
<h1>The Journey</h1>
<p>The stranger spoke of distant lands beyond the mountains.</p>
<p>He told tales of great cities with towers that touched the clouds.</p>
<p>The young people of the village listened with wide eyes and open hearts.</p>
</body>
</html>"""

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
    # mimetype must be first and stored (not compressed)
    zf.writestr("mimetype", MIMETYPE, compress_type=zipfile.ZIP_STORED)
    zf.writestr("META-INF/container.xml", CONTAINER_XML)
    zf.writestr("OEBPS/content.opf", CONTENT_OPF)
    zf.writestr("OEBPS/chapter1.xhtml", CHAPTER1)
    zf.writestr("OEBPS/chapter2.xhtml", CHAPTER2)

print(f"Created test EPUB: {OUT} ({os.path.getsize(OUT)} bytes)")
