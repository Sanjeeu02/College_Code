import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# S.db.ref('buses') -> S.db.ref('colleges/' + S.collegeCode + '/buses')
content = re.sub(r"S\.db\.ref\('buses'\)", "S.db.ref('colleges/' + S.collegeCode + '/buses')", content)

# S.db.ref('bus_profiles') -> S.db.ref('colleges/' + S.collegeCode + '/bus_profiles')
content = re.sub(r"S\.db\.ref\('bus_profiles'\)", "S.db.ref('colleges/' + S.collegeCode + '/bus_profiles')", content)

# S.db.ref('student_alerts') -> S.db.ref('colleges/' + S.collegeCode + '/student_alerts')
content = re.sub(r"S\.db\.ref\('student_alerts'\)", "S.db.ref('colleges/' + S.collegeCode + '/student_alerts')", content)

# S.db.ref(`buses/... -> S.db.ref(`colleges/${S.collegeCode}/buses/...
content = re.sub(r"S\.db\.ref\(`buses/", "S.db.ref(`colleges/${S.collegeCode}/buses/", content)

# S.db.ref(`student_alerts/... -> S.db.ref(`colleges/${S.collegeCode}/student_alerts/...
content = re.sub(r"S\.db\.ref\(`student_alerts/", "S.db.ref(`colleges/${S.collegeCode}/student_alerts/", content)

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
print("Updated app.js")
