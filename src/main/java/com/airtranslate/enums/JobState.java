package com.airtranslate.enums;

import lombok.Getter;

@Getter
public enum JobState {
    CREATED,
    UPLOADED,
    PARSING,
    TRANSLATING,
    PACKAGING,
    UPLOADING_RESULT,
    DONE,
    FAILED,
    CANCELED
}

