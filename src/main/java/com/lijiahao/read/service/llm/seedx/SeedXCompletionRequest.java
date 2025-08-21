package com.lijiahao.read.service.llm.seedx;

import lombok.Getter;
import lombok.Setter;

@Setter
@Getter
public class SeedXCompletionRequest {

    private String model = "Seed-X";
    private String prompt;
    private Integer max_tokens = 1750;
    private Float temperature = 0.0f;
    private String[] stop = {"###", "[COT]", "[END]", "（注", "----", "---", "\n\n", "（Translation", "< < < "};
    private boolean stream = false;


    // 构造函数、getter和setter
    public SeedXCompletionRequest(String prompt) {
        this.prompt = prompt;
    }
}
