package com.airtranslate.billing;

import lombok.Getter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Getter
@Component
public class BillingSettings {

    @Value("${billing.licensePublicKeyB64:}")
    private String licensePublicKeyB64;

    @Value("${billing.licenseVerifyEnabled:true}")
    private boolean licenseVerifyEnabled;

    @Value("${billing.unitChars:1000}")
    private int unitChars;

    @Value("${billing.unitCost:1}")
    private int unitCost;
}

