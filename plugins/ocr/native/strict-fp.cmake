# Preserve upstream source; override its fast-math setting after target creation.
if(MSVC)
  cmake_language(DEFER CALL target_compile_options ppocr_objects PRIVATE /fp:precise)
else()
  cmake_language(DEFER CALL target_compile_options ppocr_objects PRIVATE -fno-fast-math)
endif()
