package com.airtranslate.job.model;

import com.airtranslate.enums.TranslationEngine;
import com.airtranslate.enums.TranslationMode;
import com.airtranslate.enums.TranslationOutput;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.Map;

@Setter
@Getter
public class JobSpec {

    private String jobId;

    private TranslationEngine engine;

    private TranslationMode mode;

    private TranslationOutput output;

    private String deviceId;

    private String sourceLang;

    private String targetLang;

    private String sourceFileName;

    private String glossaryCosKey;

    private Map<String, Object> clientInfo;

    private Instant createdAt;
}
