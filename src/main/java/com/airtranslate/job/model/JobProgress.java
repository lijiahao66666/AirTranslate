package com.airtranslate.job.model;

import com.airtranslate.enums.JobState;
import com.airtranslate.enums.TranslationEngine;
import com.airtranslate.enums.TranslationMode;
import com.airtranslate.enums.TranslationOutput;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;

@Setter
@Getter
public class JobProgress {

    private String jobId;

    private JobState state;

    private int percent;

    private TranslationEngine engine;

    private TranslationMode mode;

    private TranslationOutput output;

    private ChapterProgress currentChapter;

    private UnitProgress currentUnit;

    private Double unitsPerMin;

    private Long etaSeconds;

    private JobError error;

    private Instant updatedAt;

    @Setter
    @Getter
    public static class ChapterProgress {
        private Integer index;
        private Integer total;
        private String title;
    }

    @Setter
    @Getter
    public static class UnitProgress {
        private Integer index;
        private Integer total;
    }

    @Setter
    @Getter
    public static class JobError {
        private String code;
        private String message;
    }
}

