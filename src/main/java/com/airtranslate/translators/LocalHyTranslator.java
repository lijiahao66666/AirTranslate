package com.airtranslate.translators;

import com.airtranslate.utils.StringUtil;
import com.alibaba.fastjson2.JSON;
import com.airtranslate.enums.LanguageType;
import com.airtranslate.enums.TranslatorType;

import lombok.Getter;
import lombok.Setter;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ThreadPoolExecutor;

@Slf4j
@Component
public class LocalHyTranslator implements Translator {

    private final RestTemplate restTemplate = new RestTemplate();
    private final ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();

    @Value("${hy.completionsUrl:http://localhost:8000/v1/completions}")
    private String completionsUrl;

    public LocalHyTranslator() {
        executor.setCorePoolSize(8);
        executor.setMaxPoolSize(8);
        executor.setQueueCapacity(200);
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
    }

    @Override
    public CompletableFuture<String> asyncTranslate(String source, String langCode, boolean isOnline) {
        return CompletableFuture.supplyAsync(() -> translateBlocking(source, langCode), executor);
    }

    private String translateBlocking(String source, String langCode) {
        if (StringUtils.isBlank(source)) {
            return "";
        }

        String targetLanguage = langCode;
        try {
            targetLanguage = LanguageType.valueOfLangCode(langCode).getDesc();
        } catch (Exception ignored) {
        }

        String prompt = "将以下文本翻译为" + targetLanguage + "，注意只需要输出翻译后的结果，不要额外解释：\n\n" + StringUtil.escapeJson(source);
        String result = completePrompt(prompt);
        if (result == null) {
            return source;
        }
        int index = result.indexOf("（注");
        if (index != -1) {
            result = result.substring(0, index).trim();
        }
        return result.replace("\"", "'");
    }

    public String completePrompt(String prompt) {
        CompletionRequest request = new CompletionRequest(prompt);
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<CompletionRequest> entity = new HttpEntity<>(request, headers);

        try {
            CompletionResponse response = restTemplate.postForObject(completionsUrl, entity, CompletionResponse.class);
            if (response == null || response.getChoices() == null || response.getChoices().isEmpty()) {
                return null;
            }
            String result = response.getChoices().getFirst().getText();
            return result == null ? null : result.trim();
        } catch (Exception e) {
            log.error("LocalHyTranslator request error, request={}", JSON.toJSONString(request), e);
            return null;
        }
    }

    @Override
    public TranslatorType getTranslatorType() {
        return TranslatorType.HY;
    }

    @Setter
    @Getter
    public static class CompletionRequest {
        private String prompt;
        private int max_tokens = 1024;
        private double temperature = 0.2;

        public CompletionRequest(String prompt) {
            this.prompt = prompt;
        }
    }

    @Setter
    @Getter
    public static class CompletionResponse {
        private List<Choice> choices;

        @Setter
        @Getter
        public static class Choice {
            private String text;
        }
    }
}
