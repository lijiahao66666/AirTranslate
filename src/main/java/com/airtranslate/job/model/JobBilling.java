package com.airtranslate.job.model;

import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

@Setter
@Getter
public class JobBilling {

    private String jobId;
    private String deviceId;
    private Integer unitChars;
    private Integer unitCost;
    private Integer estimatedChars;
    private Integer estimatedCost;
    private Instant estimatedAt;
    private Integer totalCost;
    private Map<String, ChapterBill> chapters;
    private Instant updatedAt;

    public Map<String, ChapterBill> safeChapters() {
        if (chapters == null) {
            chapters = new HashMap<>();
        }
        return chapters;
    }

    @Setter
    @Getter
    public static class ChapterBill {
        private Integer index;
        private Integer chars;
        private Integer cost;
        private Instant billedAt;
    }
}

