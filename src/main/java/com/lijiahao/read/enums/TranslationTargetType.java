package com.lijiahao.read.enums;

import lombok.Getter;

@Getter
public enum TranslationTargetType {
    ENGLISH(1,"<en>", "英文"),
    CHINESE(2,"<zh>", "中文"),
    ARABIC(3,"<ar>", "阿拉伯语"),
    FRENCH(4,"<fr>", "法语"),
    MALAYALAM(5,"<ms>", "马来语"),
    RUSSIAN(6,"<ru>", "俄语"),
    CZECH(7,"<cs>", "捷克语"),
    CROATIAN(8,"<hr>", "克罗地亚语"),
    NORWEGIAN_BOOK_MARKL(9,"<nb>", "挪威博克马尔语"),
    SWEDISH(10,"<sv>", "瑞典语"),
    DANISH(11,"<da>", "丹麦语"),
    HUNGARIAN(12,"<hu>", "匈牙利语"),
    DUTCH(13,"<nl>", "荷兰语"),
    THAI(14,"<th>", "泰语"),
    GERMAN(15,"<de>", "德语"),
    INDONESIAN(16,"<id>", "印度尼西亚语"),
    NORWEGIAN(17,"<no>", "挪威语"),
    ITALIAN(18,"<it>", "意大利语"),
    POLISH(19,"<pl>", "波兰语"),
    UKRAINIAN(20,"<uk>", "乌克兰语"),
    SPANISH(21,"<es>", "西班牙语"),
    JAPANESE(22,"<ja>", "日语"),
    PORTUGUESE(23,"<pt>", "葡萄牙语"),
    VIETNAMESE(24,"<vi>", "越南语"),
    FINNISH(25,"<fi>", "芬兰语"),
    KOREAN(26,"<ko>", "韩语"),
    ROMANIAN(27,"<ro>", "罗马尼亚语"),
    TURKISH(28,"<tr>", "土耳其语");

    private final Integer type;
    private final String llmTag;
    private final String info;

    TranslationTargetType(Integer type, String llmTag, String info) {
        this.type = type;
        this.llmTag = llmTag;
        this.info = info;
    }

    public static TranslationTargetType valueOf(Integer translationTargetType) {
        for (TranslationTargetType value : values()) {
            if (value.type.equals(translationTargetType)) {
                return value;
            }
        }
        throw new IllegalArgumentException("未知的翻译目标类型：" + translationTargetType);
    }
}
