package com.read.duolingo.enums;

import lombok.Getter;

@Getter
public enum LanguageType {
    ENGLISH("en", "英文"),
    CHINESE("zh", "中文"),
    ARABIC("ar", "阿拉伯语"),
    FRENCH("fr", "法语"),
    MALAYALAM("ms", "马来语"),
    RUSSIAN("ru", "俄语"),
    CZECH("cs", "捷克语"),
    CROATIAN("hr", "克罗地亚语"),
    NORWEGIAN_BOOK_MARKL("nb", "挪威博克马尔语"),
    SWEDISH("sv", "瑞典语"),
    DANISH("da", "丹麦语"),
    HUNGARIAN("hu", "匈牙利语"),
    DUTCH("nl", "荷兰语"),
    THAI("th", "泰语"),
    GERMAN("de", "德语"),
    INDONESIAN("id", "印度尼西亚语"),
    NORWEGIAN("no", "挪威语"),
    ITALIAN("it", "意大利语"),
    POLISH("pl", "波兰语"),
    UKRAINIAN("uk", "乌克兰语"),
    SPANISH("es", "西班牙语"),
    JAPANESE("ja", "日语"),
    PORTUGUESE("pt", "葡萄牙语"),
    VIETNAMESE("vi", "越南语"),
    FINNISH("fi", "芬兰语"),
    KOREAN("ko", "韩语"),
    ROMANIAN("ro", "罗马尼亚语"),
    TURKISH("tr", "土耳其语");

    private final String langCode;
    private final String desc;

    LanguageType(String langCode, String desc) {
        this.langCode = langCode;
        this.desc = desc;
    }

    public static LanguageType valueOfLangCode(String langCode) {
        for (LanguageType value : values()) {
            if (value.getLangCode().equals(langCode)) {
                return value;
            }
        }
        throw new IllegalArgumentException("未知的翻译目标类型：" + langCode);
    }
}
