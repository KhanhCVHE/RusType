# RusType

RusType là extension Chrome giúp người Việt viết, sửa lỗi, dịch và học tiếng Nga trực tiếp trên các website.

Dự án bắt đầu từ ý tưởng tạo một công cụ giống Grammarly, nhưng tập trung vào người Việt đang học hoặc sử dụng tiếng Nga. Mục tiêu của RusType là hỗ trợ viết tiếng Nga nhanh hơn, dễ hiểu hơn và có kiểm soát quyền riêng tư rõ ràng.

Phiên bản hiện tại: `0.6.13`

## Cài Đặt

RusType đã có trên Chrome Web Store:

[Cài RusType từ Chrome Web Store](https://chromewebstore.google.com/detail/rustype/jcgaojcefjdolpfohbphgjnclfbmmfeg)

## Tính Năng Chính

- Gợi ý hoàn thành từ tiếng Nga khi đang gõ.
- Kiểm tra chính tả tiếng Nga bằng Yandex Speller.
- Hiển thị gợi ý sửa nhanh gần ô nhập.
- Cho phép thêm từ riêng vào từ điển cá nhân.
- Cho phép ưu tiên các từ hay dùng trong autocomplete.
- Dịch đoạn văn bản đã bôi đen từ menu chuột phải.
- Hỗ trợ các cặp dịch: Nga ↔ Việt, Nga ↔ Anh, Anh ↔ Việt.
- Hỗ trợ AI tùy chọn cho đoạn văn bản đã chọn: giải thích, tóm tắt, viết lại.
- Cho phép người dùng tự nhập API key Gemini hoặc OpenAI.
- Có allowlist và denylist để bật/tắt extension theo website.
- Bỏ qua password field và các ô nhập nhạy cảm.

## Dành Cho Ai

RusType được thiết kế cho người Việt đang học hoặc sử dụng tiếng Nga: học sinh, sinh viên, người đi làm, người bán hàng, nhân viên hỗ trợ khách hàng, người sống ở môi trường cần dùng tiếng Nga hằng ngày.

RusType không phải là công cụ kiểm tra ngữ pháp tiếng Anh tổng quát. Công cụ này tập trung vào việc giúp người Việt viết và hiểu tiếng Nga trong các tình huống thực tế trên web.

## Trạng Thái Dự Án

RusType đã được Google chấp nhận và phát hành trên Chrome Web Store. Repository này chứa source code của extension, script build và công cụ phục vụ phát triển.

Một số phần vẫn đang được phát triển:

- Google Docs đang được tắt chủ động vì chưa hỗ trợ ổn định.
- Kiểm tra ngữ pháp nâng cao đang tạm dừng.
- OCR cho PDF scan/ảnh chưa được hỗ trợ.
- Tính năng AI yêu cầu người dùng tự cung cấp API key Gemini hoặc OpenAI.

## Quyền Riêng Tư

RusType xử lý văn bản người dùng nhập, vì vậy quyền riêng tư là yêu cầu cốt lõi.

- Autocomplete chạy cục bộ bằng từ điển được đóng gói trong extension.
- Kiểm tra chính tả chỉ gửi các đoạn tiếng Nga ngắn tới Yandex Speller khi người dùng bật kiểm tra chính tả.
- Dịch chỉ gửi đoạn văn bản đã bôi đen tới Google Translate sau khi người dùng chọn hành động RusType từ menu chuột phải.
- AI chỉ gửi đoạn văn bản đã bôi đen tới Gemini hoặc OpenAI khi người dùng bật AI, nhập API key và chọn hành động AI.
- API key được lưu cục bộ trong Chrome extension storage.
- Password field và các ô nhập nhạy cảm được bỏ qua.
- Người dùng có thể tắt extension, autocomplete, kiểm tra chính tả, dịch/AI theo đoạn bôi đen và thiết lập bật/tắt theo từng website.

Thông tin quyền riêng tư chi tiết hơn có trong trang Chrome Web Store và trong phần cài đặt của extension.

## Cấu Trúc Dự Án

```text
apps/
  api/                 API prototype phục vụ phát triển
  extension/           Chrome extension dùng Manifest V3
tools/
  build-autocomplete-dictionary.mjs
  package-extension.mjs
```

Code runtime chính của extension nằm trong:

```text
apps/extension/src/background/
apps/extension/src/content/
apps/extension/src/options/
apps/extension/src/popup/
apps/extension/src/selection/
```

## Thiết Lập Cho Developer

Người dùng thông thường nên cài RusType từ Chrome Web Store. Các bước dưới đây chỉ dành cho phát triển hoặc test source code local.

1. Mở Chrome.
2. Vào `chrome://extensions`.
3. Bật `Developer mode`.
4. Bấm `Load unpacked`.
5. Chọn thư mục:

```text
apps/extension
```

Sau khi load extension, mở một website có `input`, `textarea` hoặc `contenteditable`, rồi thử gõ tiếng Nga.

## Cách Dùng Autocomplete

Autocomplete hiển thị gần ô nhập đang hoạt động.

- `Tab` chuyển giữa các gợi ý đang hiển thị.
- `Shift + Tab` quay lại gợi ý trước.
- `Enter` chấp nhận gợi ý đang chọn.
- `Esc` đóng gợi ý.

Số lượng gợi ý mặc định có thể chỉnh trong phần cài đặt của extension.

## Dịch Và AI Với Đoạn Bôi Đen

Bôi đen văn bản trên trang, bấm chuột phải, rồi chọn:

- `RusType: Dịch đoạn đã chọn`
- `RusType: Sử dụng AI với đoạn đã chọn`

Dịch có thể dùng ngay. Tính năng AI yêu cầu người dùng cấu hình Gemini hoặc OpenAI trong phần cài đặt.

## Kiểm Tra Code

```bash
node --check apps/extension/src/content/content-script.js
node --check apps/extension/src/options/options.js
node --check apps/extension/src/background/service-worker.js
node apps/extension/dev/autocomplete-engine.test.js
node apps/extension/dev/grammar-rules.test.js
```

## Build Từ Điển Autocomplete

Extension sử dụng file từ điển đã được generate sẵn:

```text
apps/extension/src/content/autocomplete-dictionary.generated.js
```

Để build lại từ nguồn TSV/frequency:

```bash
node tools/build-autocomplete-dictionary.mjs \
  --input apps/extension/data/russian-autocomplete.seed.tsv \
  --output apps/extension/src/content/autocomplete-dictionary.generated.js \
  --limit 50000
```

## Đóng Gói Extension

```bash
node tools/package-extension.mjs
```

Lệnh này tạo file:

```text
dist/rustype-extension-<version>.zip
```

Thư mục `dist/` được ignore và không đưa lên git.

## Dịch Vụ Bên Thứ Ba

RusType hiện tích hợp với:

- [Yandex Speller](http://api.yandex.ru/speller/) để kiểm tra chính tả tiếng Nga.
- Google Translate để dịch đoạn văn bản người dùng đã chọn.
- Gemini API hoặc OpenAI API cho tính năng AI tùy chọn khi người dùng tự cấu hình.

## Giấy Phép

Dự án được phát hành theo MIT License. Xem chi tiết trong file `LICENSE`.
