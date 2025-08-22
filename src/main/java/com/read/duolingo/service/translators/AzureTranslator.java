package com.read.duolingo.service.translators;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import com.read.duolingo.enums.TranslatorType;
import com.read.duolingo.utils.StringUtil;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

@Slf4j
@Component
public class AzureTranslator implements Translator {

    private final RestTemplate restTemplate = new RestTemplate();
    private static TokenCache tokenCache = null;
    private final ThreadPoolTaskExecutor azureExecutor = new ThreadPoolTaskExecutor();

    public AzureTranslator() {
        azureExecutor.setCorePoolSize(100);
        azureExecutor.setMaxPoolSize(100);
        azureExecutor.setRejectedExecutionHandler(new ThreadPoolExecutor.DiscardPolicy());
        azureExecutor.initialize();
    }

    @Override
    public CompletableFuture<String> asyncTranslate(String source, String langCode, boolean isOnline) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                return queryAzure(source, langCode);
            } catch (Exception e) {
                log.error("AzureTranslator asyncTranslate error", e);
                return source;
            }
        }, azureExecutor);
    }

    private String queryAzure(String source, String targetLang) throws Exception {
        if (source.isEmpty()) {
            return "";
        }

        String msTargetLang = normalizeToFullLang(targetLang);

        String url = "https://api-edge.cognitive.microsofttranslator.com/translate";
        String params = "?to=" + URLEncoder.encode(msTargetLang, StandardCharsets.UTF_8) + "&api-version=3.0";

        String token = getAuthToken();
        
        HttpHeaders headers = new HttpHeaders();
        headers.set("Content-Type", "application/json");
        headers.set("Authorization", "Bearer " + token);
        
        TranslationRequest request = new TranslationRequest(source);
        HttpEntity<TranslationRequest[]> entity = new HttpEntity<>(new TranslationRequest[]{request}, headers);

        TranslationResponse[] response = restTemplate.postForObject(
                url + params,
                entity,
                TranslationResponse[].class
        );

        if (response != null && response.length > 0 && response[0].getTranslations() != null 
                && response[0].getTranslations().length > 0) {
            return response[0].getTranslations()[0].getText();
        } else {
            return source;
        }
    }

    private String getAuthToken() {
        long now = System.currentTimeMillis();
        if (tokenCache != null && tokenCache.expiresAt > now) {
            return tokenCache.token;
        }
        
        HttpHeaders headers = new HttpHeaders();
        headers.set("User-Agent", "Mozilla/5.0");
        HttpEntity<String> entity = new HttpEntity<>(headers);
        
        String token = restTemplate.getForObject(
                "https://edge.microsoft.com/translate/auth",
                String.class,
                entity
        );

        long expiresAt = now + TimeUnit.MINUTES.toMillis(8); // 8 minutes expiration

        tokenCache = new TokenCache(token, expiresAt);
        return token;
    }

    private static String normalizeToFullLang(String lang) {
        Map<String, String> langMap = new HashMap<>();
        langMap.put("en", "en-US");
        langMap.put("fr", "fr-FR");
        langMap.put("de", "de-DE");
        langMap.put("es", "es-ES");
        langMap.put("ja", "ja-JP");
        langMap.put("it", "it-IT");
        langMap.put("ko", "ko-KR");
        langMap.put("pt", "pt-PT");
        langMap.put("ar", "ar-SA");
        langMap.put("nl", "nl-NL");
        langMap.put("pl", "pl-PL");
        langMap.put("tr", "tr-TR");
        langMap.put("id", "id-ID");
        langMap.put("ru", "ru-RU");
        langMap.put("uk", "uk-UA");
        langMap.put("th", "th-TH");
        langMap.put("no", "no-NO");
        langMap.put("sv", "sv-SE");
        langMap.put("fi", "fi-FI");
        langMap.put("da", "da-DK");
        langMap.put("cs", "cs-CZ");
        langMap.put("hu", "hu-HU");
        langMap.put("ro", "ro-RO");
        langMap.put("bg", "bg-BG");
        langMap.put("hr", "hr-HR");
        langMap.put("lt", "lt-LT");
        langMap.put("sl", "sl-SI");
        langMap.put("sk", "sk-SK");
        langMap.put("bo", "bo-CN");
        langMap.put("zh", "zh-Hans");
        langMap.put("zh-cn", "zh-Hans");
        langMap.put("zh-tw", "zh-Hant");
        langMap.put("zh-mo", "zh-Hant");
        langMap.put("zh-hans", "zh-Hans");
        langMap.put("zh-hant", "zh-Hant");

        return langMap.getOrDefault(lang, lang);
    }



    @AllArgsConstructor
    private static class TokenCache {
        String token;
        long expiresAt;
    }

    @Data
    private static class TranslationRequest {
        private String Text;

        public TranslationRequest(String text) {
            Text = StringUtil.escapeJson(text);
        }
    }

    @Data
    private static class TranslationResponse {
        private Translation[] translations;

    }
    
    @Data
    private static class Translation {
        private String text;
        private String to;

    }

    public TranslatorType getTranslatorType() {
        return TranslatorType.AZURE;
    }

}