package com.lijiahao.read.enums;

import lombok.Getter;

@Getter
public enum TranslationStatus {
    NOT_START(0, "未开始"),
    TRANSLATING(1, "翻译中"),
    COMPLETED(2, "已完成"),
    FAILED(3, "翻译失败");
    private final int value;
    private final String desc;
    TranslationStatus(int value, String desc) {
        this.value = value;
        this.desc = desc;
    }
}
