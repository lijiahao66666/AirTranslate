package com.read.duolingo.service.translators;

import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ThreadPoolExecutor;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.read.duolingo.enums.TranslatorType;
import com.read.duolingo.utils.StringUtil;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestTemplate;

@Slf4j
@Component
public class GoogleTranslator implements Translator{

    private final RestTemplate restTemplate = new RestTemplate();
    private final ThreadPoolTaskExecutor googleExecutor = new ThreadPoolTaskExecutor();

    public GoogleTranslator() {
        googleExecutor.setCorePoolSize(100);
        googleExecutor.setMaxPoolSize(100);
        googleExecutor.setRejectedExecutionHandler(new ThreadPoolExecutor.DiscardPolicy());
        googleExecutor.initialize();
    }

    @Override
    public CompletableFuture<String> asyncTranslate(String source, String langCode, boolean isOnline) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                return queryGoogle(source, langCode);
            } catch (Exception e) {
                log.error("GoogleTranslator asyncTranslate error", e);
                return source;
            }
        }, googleExecutor);
    }

    private String queryGoogle(String source, String targetLang) throws Exception {
        if (source.isEmpty()) {
            return "";
        }

        String url = "https://translate.googleapis.com/translate_a/single";

        // 使用表单参数而不是URL参数
        MultiValueMap<String, String> formData = new LinkedMultiValueMap<>();
        formData.add("client", "gtx");
        formData.add("sl", "auto");
        formData.add("tl", targetLang);
        formData.add("dt", "t");
        formData.add("q", source);  // 直接使用原始文本，不需要URL编码

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        headers.set("User-Agent", "Mozilla/5.0");
        HttpEntity<MultiValueMap<String, String>> entity = new HttpEntity<>(formData, headers);

        Object[] response = restTemplate.postForObject(url, entity, Object[].class);

        // 解析Google翻译响应
        if (response != null && response.length > 0 && response[0] instanceof List<?> firstElement) {
            if (!firstElement.isEmpty() && firstElement.getFirst() instanceof List<?> translationData) {
                if (!translationData.isEmpty() && translationData.getFirst() instanceof String result) {
                    return result;
                }
            }
        }
        
        return source;
    }

    @Override
    public TranslatorType getTranslatorType() {
        return TranslatorType.GOOGLE;
    }

    // For testing
    public static void main(String[] args) {
        try {
            // 测试实际翻译
            String s = new GoogleTranslator().queryGoogle("你是谁&q=我是李家豪", "en");
            System.out.println("中文翻译英文: " + s);

        } catch (Exception e) {
            log.error("GoogleTranslator main error", e);
            e.printStackTrace();
        }
    }
}