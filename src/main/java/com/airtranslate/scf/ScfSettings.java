package com.airtranslate.scf;

import lombok.Getter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Getter
@Component
public class ScfSettings {

    @Value("${scf.baseUrl:}")
    private String baseUrl;

    @Value("${scf.workerSecret:}")
    private String workerSecret;
}

