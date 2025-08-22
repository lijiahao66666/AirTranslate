package com.read.duolingo.service.translators;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.read.duolingo.enums.TranslatorType;
import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
@Slf4j
@Component
public class AzureTranslator implements Translator {

    private static final String AZURE_TRANSLATE_URL = "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=%s&from=%s";

    private static TokenCache tokenCache = null;
    private static final ObjectMapper objectMapper = new ObjectMapper();

    private static String getAuthToken() throws Exception {
        long now = System.currentTimeMillis();
        if (tokenCache != null && tokenCache.expiresAt > now) {
            return tokenCache.token;
        }
        try {
            HttpURLConnection connection = (HttpURLConnection) new URI(AZURE_TRANSLATE_URL).toURL().openConnection();
            connection.setRequestMethod("GET");
            connection.setRequestProperty("User-Agent", "Mozilla/5.0");

            int responseCode = connection.getResponseCode();
            if (responseCode != 200) {
                throw new Exception("Failed to get auth token: " + responseCode);
            }

            StringBuilder response = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    response.append(line);
                }
            }

            String token = response.toString();
            long expiresAt = now + TimeUnit.MINUTES.toMillis(8); // 8 minutes expiration

            tokenCache = new TokenCache(token, expiresAt);
            return token;
        } catch (Exception error) {
            System.err.println("Error getting Microsoft translation auth token: " + error.getMessage());
            throw error;
        }
    }

    public static List<String> translate(List<String> texts, String sourceLang, String targetLang) throws Exception {
        if (texts.isEmpty()) {
            return new ArrayList<>();
        }

        List<String> results = new ArrayList<>(Collections.nCopies(texts.size(), null));
        String msTargetLang = normalizeToFullLang(targetLang);
        String msSourceLang = sourceLang != null && !sourceLang.isEmpty() ? normalizeToFullLang(sourceLang) : "";

        List<Thread> threads = new ArrayList<>();

        for (int i = 0; i < texts.size(); i++) {
            final int index = i;
            final String text = texts.get(i);

            Thread thread = new Thread(() -> {
                try {
                    if (text == null || text.trim().isEmpty()) {
                        results.set(index, text);
                        return;
                    }

                    String url = "https://api-edge.cognitive.microsofttranslator.com/translate";
                    StringBuilder params = new StringBuilder();
                    params.append("?to=").append(URLEncoder.encode(msTargetLang, StandardCharsets.UTF_8));
                    params.append("&api-version=3.0");

                    if (msSourceLang != null && !msSourceLang.isEmpty() &&
                            !msSourceLang.equalsIgnoreCase("auto")) {
                        params.append("&from=").append(URLEncoder.encode(msSourceLang, StandardCharsets.UTF_8));
                    }

                    String token = getAuthToken();
                    URL translationUrl = new URI(url + params).toURL();
                    HttpURLConnection connection = (HttpURLConnection) translationUrl.openConnection();
                    connection.setRequestMethod("POST");
                    connection.setRequestProperty("Content-Type", "application/json");
                    connection.setRequestProperty("Authorization", "Bearer " + token);
                    connection.setDoOutput(true);

                    String requestBody = "[{\"Text\":\"" + escapeJson(text) + "\"}]";

                    try (OutputStream os = connection.getOutputStream()) {
                        byte[] input = requestBody.getBytes(StandardCharsets.UTF_8);
                        os.write(input, 0, input.length);
                    }

                    int responseCode = connection.getResponseCode();
                    if (responseCode != 200) {
                        throw new Exception("Translation failed with status " + responseCode);
                    }

                    StringBuilder response = new StringBuilder();
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                        String line;
                        while ((line = reader.readLine()) != null) {
                            response.append(line);
                        }
                    }

                    JsonNode data = objectMapper.readTree(response.toString());
                    if (data.isArray() && !data.isEmpty()) {
                        JsonNode translations = data.get(0).get("translations");
                        if (translations != null && translations.isArray() && !translations.isEmpty()) {
                            String translatedText = translations.get(0).get("text").asText();
                            results.set(index, translatedText);
                        } else {
                            results.set(index, text);
                        }
                    } else {
                        results.set(index, text);
                    }
                } catch (Exception e) {
                    System.err.println("Translation error for text at index " + index + ": " + e.getMessage());
                    results.set(index, text); // fallback to original text
                }
            });

            threads.add(thread);
            thread.start();
        }

        // Wait for all threads to complete
        for (Thread thread : threads) {
            thread.join();
        }

        return results;
    }

    private static String normalizeToFullLang(String lang) {
        // Simplified implementation - in a real app, you would have a complete mapping
        Map<String, String> langMap = new HashMap<>();
        langMap.put("en", "en-US");
        langMap.put("zh", "zh-CN");
        langMap.put("fr", "fr-FR");
        langMap.put("de", "de-DE");
        langMap.put("es", "es-ES");
        langMap.put("ja", "ja-JP");

        return langMap.getOrDefault(lang, lang);
    }

    private static String escapeJson(String text) {
        if (text == null) return "";
        return text.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }

    // For testing
    public static void main(String[] args) {
        try {
            List<String> texts = Arrays.asList("Hello, world!", "How are you?");
            List<String> translations = translate(texts, "en", "zh");
            System.out.println("Translations: " + translations);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    @AllArgsConstructor
    private static class TokenCache {
        String token;
        long expiresAt;
    }

    public TranslatorType getTranslatorType() {
        return TranslatorType.AZURE;
    }

    @Override
    public CompletableFuture<String> asyncTranslate(String source, String langCode, boolean isOnline) {
        return null;
    }
}