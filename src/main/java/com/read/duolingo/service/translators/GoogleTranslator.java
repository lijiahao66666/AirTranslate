package com.read.duolingo.service.translators;

import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
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
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.stereotype.Component;
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
        String params = "?client=gtx&sl=auto&tl=" + URLEncoder.encode(targetLang, StandardCharsets.UTF_8) +
                "&dt=t&q=" + URLEncoder.encode(StringUtil.escapeJson(source), StandardCharsets.UTF_8);

        HttpHeaders headers = new HttpHeaders();
        headers.set("User-Agent", "Mozilla/5.0");
        HttpEntity<String> entity = new HttpEntity<>(headers);

        // 使用Object数组接收响应，因为Google翻译API的响应格式不是标准的JSON对象
        Object[] response = restTemplate.exchange(
                url + params,
                HttpMethod.GET,
                entity,
                Object[].class
        ).getBody();

        // 解析Google翻译响应
        if (response != null && response.length > 0 && response[0] instanceof List<?> firstElement) {
            if (!firstElement.isEmpty() && firstElement.getFirst() instanceof List<?> translationData) {
                if (!translationData.isEmpty() && translationData.getFirst() instanceof String result) {
                    // 先替换全角百分号为半角百分号，再进行URL解码
                    result = result.replace("％", "%").replace(" ", "");
                    return URLDecoder.decode(result, StandardCharsets.UTF_8);
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
            String s = new GoogleTranslator().queryGoogle("你是一个什么人？", "en");
            System.out.println("Translations: " + s);
        } catch (Exception e) {
            log.error("GoogleTranslator main error", e);
            e.printStackTrace();
        }
    }
}