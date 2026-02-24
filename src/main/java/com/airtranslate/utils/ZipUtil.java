package com.airtranslate.utils;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

public class ZipUtil {

    public static void unzipEpub(String epubPath, Path destDir) throws IOException {
        Path base = destDir.toAbsolutePath().normalize();
        try (ZipFile zipFile = new ZipFile(new File(epubPath))) {
            Enumeration<? extends ZipEntry> entries = zipFile.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                Path entryPath = base.resolve(entry.getName()).normalize();
                if (!entryPath.startsWith(base)) {
                    throw new IOException("Invalid zip entry: " + entry.getName());
                }

                if (entry.isDirectory()) {
                    Files.createDirectories(entryPath);
                } else {
                    Files.createDirectories(entryPath.getParent());
                    try (InputStream in = zipFile.getInputStream(entry);
                         OutputStream out = Files.newOutputStream(entryPath)) {
                        byte[] buffer = new byte[4096];
                        int bytesRead;
                        while ((bytesRead = in.read(buffer)) != -1) {
                            out.write(buffer, 0, bytesRead);
                        }
                    }
                }
            }
        }
    }

    public static void zipEpub(Path sourceDir, String outputPath) throws IOException {
        Path base = sourceDir.toAbsolutePath().normalize();
        Path mimetypePath = base.resolve("mimetype");
        try (ZipOutputStream zos = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(outputPath)))) {
            if (Files.exists(mimetypePath) && Files.isRegularFile(mimetypePath)) {
                byte[] bytes = Files.readAllBytes(mimetypePath);
                CRC32 crc32 = new CRC32();
                crc32.update(bytes);
                ZipEntry zipEntry = new ZipEntry("mimetype");
                zipEntry.setMethod(ZipEntry.STORED);
                zipEntry.setSize(bytes.length);
                zipEntry.setCompressedSize(bytes.length);
                zipEntry.setCrc(crc32.getValue());
                zos.putNextEntry(zipEntry);
                zos.write(bytes);
                zos.closeEntry();
            }

            try (var stream = Files.walk(base)) {
                stream.filter(path -> Files.isRegularFile(path))
                        .filter(path -> !path.equals(mimetypePath))
                        .sorted(Comparator.comparing(p -> base.relativize(p).toString()))
                        .forEach(path -> {
                            String entryName = base.relativize(path).toString().replace("\\", "/");
                            ZipEntry zipEntry = new ZipEntry(entryName);
                            try {
                                zos.putNextEntry(zipEntry);
                                try (InputStream in = Files.newInputStream(path)) {
                                    in.transferTo(zos);
                                }
                                zos.closeEntry();
                            } catch (IOException e) {
                                throw new UncheckedIOException(e);
                            }
                        });
            }
        }
    }

}
