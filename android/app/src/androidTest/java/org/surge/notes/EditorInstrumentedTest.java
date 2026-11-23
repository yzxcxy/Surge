package org.surge.notes;

import static org.junit.Assert.*;

import android.content.Context;
import android.graphics.Point;
import android.view.KeyEvent;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class EditorInstrumentedTest {
    private MainActivity activity;
    private WebView web;

    private String js(String code) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        activity.runOnUiThread(() -> web.evaluateJavascript(code, value -> { result.set(value); done.countDown(); }));
        assertTrue("JavaScript timed out", done.await(10, TimeUnit.SECONDS));
        return result.get();
    }
    private void awaitJs(String condition) throws Exception {
        for (int i = 0; i < 80; i++) {
            if ("true".equals(js("Boolean(" + condition + ")"))) return;
            Thread.sleep(100);
        }
        fail("Condition not reached: " + condition);
    }
    private void key(int code) { InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(code); }
    private void type(String text) { InstrumentationRegistry.getInstrumentation().sendStringSync(text); }

    @Test public void editorOnAndroid() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(a -> { activity = a; web = a.getBridge().getWebView(); });
            awaitJs("typeof document.querySelector('#new-note')?.onclick === 'function' && !document.querySelector('#new-note').hidden");
            js("document.querySelector('#new-note').click()");
            awaitJs("!document.querySelector('#editor').hidden && document.querySelector('#note-title').clientWidth > 0");
            js("(()=>{let t=document.querySelector('#note-title'); t.value='Long title '.repeat(18); t.dispatchEvent(new Event('input',{bubbles:true}));})()");
            assertEquals("true", js("(()=>{let t=document.querySelector('#note-title'); return t.scrollHeight > parseFloat(getComputedStyle(t).lineHeight)*1.5})()"));
            assertEquals("true", js("(()=>{let t=document.querySelector('#editor-toolbar'), b=[...t.querySelectorAll('button')]; let r=t.getBoundingClientRect(); return b.length===7 && b[0].getBoundingClientRect().left >= r.left && b[6].getBoundingClientRect().right <= r.right && Math.abs(b[0].getBoundingClientRect().width-b[6].getBoundingClientRect().width)<1})()"));
            js("document.querySelector('#note-body').focus()");
            scenario.onActivity(a -> ((InputMethodManager)a.getSystemService(Context.INPUT_METHOD_SERVICE)).showSoftInput(web, InputMethodManager.SHOW_IMPLICIT));
            for (int i=0; i<50; i++) {
                AtomicReference<Boolean> visible = new AtomicReference<>(false);
                scenario.onActivity(a -> { WindowInsets insets=a.getWindow().getDecorView().getRootWindowInsets(); visible.set(insets != null && insets.isVisible(WindowInsets.Type.ime())); });
                if (visible.get()) break;
                Thread.sleep(100);
                if (i == 49) fail("Android keyboard did not open");
            }
            AtomicReference<Float> visibleHeight = new AtomicReference<>();
            scenario.onActivity(a -> {
                Point screen = new Point();
                a.getWindowManager().getDefaultDisplay().getRealSize(screen);
                int ime = a.getWindow().getDecorView().getRootWindowInsets().getInsets(WindowInsets.Type.ime()).bottom;
                visibleHeight.set((screen.y - ime) / a.getResources().getDisplayMetrics().density);
            });
            awaitJs("Math.abs(document.querySelector('#editor-toolbar').getBoundingClientRect().bottom - " + visibleHeight.get() + ") < 4");
            type("- ");
            awaitJs("document.querySelector('#note-body ul li')");
            type("item"); key(KeyEvent.KEYCODE_ENTER); key(KeyEvent.KEYCODE_ENTER); type("after");
            assertEquals("true", js("(()=>{let e=document.querySelector('#note-body');return e.querySelectorAll('ul li').length===1 && e.querySelector('ul li').textContent==='item' && e.querySelector('p')?.textContent==='after'})()"));
            key(KeyEvent.KEYCODE_ENTER); type("1. ");
            awaitJs("document.querySelector('#note-body ol li')");
            type("number"); key(KeyEvent.KEYCODE_ENTER); key(KeyEvent.KEYCODE_ENTER); type("### "); type("heading");
            awaitJs("document.querySelector('#note-body h3')?.textContent === 'heading'");
            js("(()=>{let h=document.querySelector('#note-body h3'), s=getSelection(), r=document.createRange(); r.selectNodeContents(h);r.collapse(true);s.removeAllRanges();s.addRange(r)})()");
            key(KeyEvent.KEYCODE_DEL);
            awaitJs("!document.querySelector('#note-body h3') && [...document.querySelectorAll('#note-body p')].some(p=>p.textContent==='heading')");
        }
    }
}
