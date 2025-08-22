package com.read.duolingo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@EnableScheduling
@SpringBootApplication
public class ReadDuolingoApplication {

	public static void main(String[] args) {
		SpringApplication.run(ReadDuolingoApplication.class, args);
	}

}
