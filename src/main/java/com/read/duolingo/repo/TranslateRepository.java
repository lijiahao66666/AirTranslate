package com.read.duolingo.repo;

import com.read.duolingo.entity.OfflineTranslateTemp;
import com.read.duolingo.repo.mapper.OfflineTranslateTempMapper;
import jakarta.annotation.Resource;
import org.springframework.stereotype.Repository;

import java.util.*;

@Repository
public class TranslateRepository{

    @Resource
    private OfflineTranslateTempMapper offlineTranslateTempMapper;

    public Long insertOfflineTranslateTemp(OfflineTranslateTemp offlineTranslateTemp) {
        if(offlineTranslateTemp == null){
            return null;
        }
        offlineTranslateTempMapper.insertSelective(offlineTranslateTemp);
        return offlineTranslateTemp.getId();
    }

    public OfflineTranslateTemp findOfflineTranslateTempById(Long bookId) {
        return offlineTranslateTempMapper.selectById(bookId);
    }

    public void updateOfflineTranslateTemp(OfflineTranslateTemp offlineTranslateTemp) {
        if(offlineTranslateTemp == null){
            return;
        }
        offlineTranslateTempMapper.updateSelective(offlineTranslateTemp);
    }


    public OfflineTranslateTemp getOfflineTranslateTempByTranslationStatus(List<Integer> translationStatus) {
        if(translationStatus == null || translationStatus.isEmpty()){
            return null;
        }
        return offlineTranslateTempMapper.getByTranslationStatus(translationStatus);
    }

}