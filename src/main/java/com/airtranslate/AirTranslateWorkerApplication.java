package com.airtranslate;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@EnableScheduling
@SpringBootApplication
public class AirTranslateWorkerApplication {

    public static void main(String[] args) {
        SpringApplication.run(AirTranslateWorkerApplication.class, args);
    }
}

