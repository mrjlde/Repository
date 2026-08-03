[README.txt](https://github.com/user-attachments/files/30645946/README.txt)
AUTO UNZIP DROP FOLDER
Created by Jay.D

WHAT THIS DOES
- Leave "run-auto-unzip.bat" running.
- Drop .zip files into the folder: DROP_ZIPS_HERE
- The script will automatically extract each zip to: unzipped\<zipname>\
- After extraction:
    - The .zip file is moved to: _done
    - If a zip fails, it is moved to: _error
- A log is written to: auto-unzip.log

HOW TO USE
1) Double-click: run-auto-unzip.bat
2) Keep the window open (this is the “service” running)
3) Put .zip files into: DROP_ZIPS_HERE
4) Check results in: unzipped
5) If something fails, look in: _error and auto-unzip.log

NOTES
- If you copy big zips, the script waits until the file finishes copying before unzipping.
- If two zips have the same name, it creates a unique output folder automatically.

SECURITY / PERMISSIONS (if shared)
- Users need write access to DROP_ZIPS_HERE, unzipped, _done, _error, and auto-unzip.log.
