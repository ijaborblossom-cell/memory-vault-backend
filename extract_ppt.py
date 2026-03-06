import zipfile
import xml.etree.ElementTree as ET
import re

z = zipfile.ZipFile(r'C:\Users\Blossomation\Downloads\Memory_Vault_Mature_Clean_White_Bold.pptx')
slides = [f for f in z.namelist() if f.startswith('ppt/slides/slide') and f.endswith('.xml')]
slides = sorted(slides, key=lambda x: int(re.search(r'slide(\d+)\.xml', x).group(1)))

with open('ppt_extract.txt', 'w', encoding='utf-8') as f:
    for s in slides:
        f.write(f'\n--- {s} ---\n')
        xml_content = z.read(s)
        root = ET.fromstring(xml_content)
        for t in root.iter():
            if t.tag.endswith('}t') and t.text:
                f.write(t.text + '\n')
