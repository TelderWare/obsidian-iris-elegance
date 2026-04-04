"""
Echo360 login — returns session cookies as JSON.
Adapted from Iris's echo360_login.py.
"""

import argparse
import json
import sys

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException


def progress(message):
    print(json.dumps({"status": "progress", "message": message}), flush=True)


def output(status, message, **extra):
    result = {"status": status, "message": message, **extra}
    print(json.dumps(result))
    sys.exit(0 if status == "success" else 1)


def find_and_click_button(driver, strategies):
    for by, value in strategies:
        try:
            el = driver.find_element(by, value)
            if el.is_displayed() and el.is_enabled():
                el.click()
                return True
        except NoSuchElementException:
            continue
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args()

    # Read credentials from stdin (not CLI args, to avoid process list exposure)
    try:
        creds = json.loads(sys.stdin.read())
        args.email = creds["email"]
        args.password = creds["password"]
    except (json.JSONDecodeError, KeyError):
        output("error", "Failed to read credentials from stdin")

    options = webdriver.ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1280,900")
    options.add_argument("--log-level=3")
    options.add_experimental_option("excludeSwitches", ["enable-logging"])
    driver = webdriver.Chrome(options=options)
    wait = WebDriverWait(driver, args.timeout)

    try:
        driver.get("https://echo360.org.uk")
        progress("Navigating to Echo360...")

        # Step 1: Email
        email_input = None
        try:
            email_input = wait.until(EC.visibility_of_element_located((
                By.CSS_SELECTOR,
                'input[type="email"], input[name="email"], input[name="username"], '
                'input[id="email"], input[id="username"]'
            )))
        except TimeoutException:
            all_inputs = driver.find_elements(
                By.CSS_SELECTOR, "input[type='text'], input[type='email'], input:not([type])")
            visible = [i for i in all_inputs if i.is_displayed()]
            if visible:
                email_input = visible[0]

        if not email_input:
            output("error", "Could not find email input")

        email_input.clear()
        email_input.send_keys(args.email)

        if not find_and_click_button(driver, [
            (By.CSS_SELECTOR, 'button[type="submit"]'),
            (By.CSS_SELECTOR, 'input[type="submit"]'),
            (By.CSS_SELECTOR, 'button[name="action"]'),
        ]):
            email_input.send_keys(Keys.RETURN)

        progress("Submitting credentials...")

        # Step 2: Password
        try:
            password_input = wait.until(EC.visibility_of_element_located((
                By.CSS_SELECTOR,
                'input[type="password"], input[name="password"], input[id="password"]'
            )))
        except TimeoutException:
            output("error", "Could not find password input")

        for sel in ['input[type="email"]', 'input[name="email"]', 'input[name="username"]']:
            try:
                el = driver.find_element(By.CSS_SELECTOR, sel)
                if el.is_displayed() and el != password_input and not el.get_attribute("value").strip():
                    el.clear()
                    el.send_keys(args.email)
                    break
            except NoSuchElementException:
                continue

        password_input.clear()
        password_input.send_keys(args.password)

        if not find_and_click_button(driver, [
            (By.CSS_SELECTOR, 'button[type="submit"]'),
            (By.CSS_SELECTOR, 'input[type="submit"]'),
            (By.CSS_SELECTOR, 'button[name="action"]'),
        ]):
            password_input.send_keys(Keys.RETURN)

        progress("Waiting for login redirect...")

        try:
            wait.until(lambda d: (
                "login" not in d.current_url.lower()
                and "auth" not in d.current_url.lower()
                and "signin" not in d.current_url.lower()
            ))
        except TimeoutException:
            error_els = driver.find_elements(
                By.CSS_SELECTOR, '[class*="error"], [class*="alert"], [role="alert"]')
            for el in error_els:
                if el.is_displayed() and el.text.strip():
                    output("error", f"Login failed: {el.text.strip()}")
            output("error", "Login timed out")

        cookies = driver.get_cookies()
        progress("Extracting session cookies...")
        output("success", "Login complete", cookies=cookies)

    except SystemExit:
        raise
    except Exception as e:
        output("error", f"Unexpected error: {str(e)}")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
