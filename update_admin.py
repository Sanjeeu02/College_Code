with open('admin.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update Realtime DB paths in admin.html
content = content.replace("db.ref('buses')", "db.ref('colleges/' + currentCollegeCode + '/buses')")
content = content.replace("db.ref('bus_profiles')", "db.ref('colleges/' + currentCollegeCode + '/bus_profiles')")
content = content.replace("db.ref('student_alerts')", "db.ref('colleges/' + currentCollegeCode + '/student_alerts')")
content = content.replace("db.ref(`buses/", "db.ref(`colleges/${currentCollegeCode}/buses/")
content = content.replace("db.ref(`bus_profiles/", "db.ref(`colleges/${currentCollegeCode}/bus_profiles/")
content = content.replace("db.ref(`student_alerts/", "db.ref(`colleges/${currentCollegeCode}/student_alerts/")

auth_logic = """
        let currentCollegeCode = null;

        function handleAuthSuccess(user) {
            currentUser = user.uid;
            localStorage.setItem('ba_admin_uid', user.uid);
            
            // Fetch admin profile to get collegeCode
            adminDb.collection('admins').doc(user.uid).get().then(doc => {
                if (doc.exists && doc.data().collegeCode) {
                    currentCollegeCode = doc.data().collegeCode;
                    finishAdminLogin();
                } else {
                    const code = prompt("Please register a unique College Code for your institution (e.g., SRM123):");
                    if (code && code.trim()) {
                        const cleanCode = code.trim().toUpperCase().replace(/\\s/g, '');
                        studentDb.collection('colleges').doc(cleanCode).get().then(collegeDoc => {
                            if (collegeDoc.exists) {
                                alert("College Code already in use! Please login again and pick a different one.");
                                auth.signOut();
                            } else {
                                studentDb.collection('colleges').doc(cleanCode).set({
                                    name: cleanCode + " College",
                                    adminUid: user.uid,
                                    createdAt: Date.now()
                                }).then(() => {
                                    adminDb.collection('admins').doc(user.uid).update({ collegeCode: cleanCode }).then(() => {
                                        currentCollegeCode = cleanCode;
                                        finishAdminLogin();
                                    });
                                });
                            }
                        });
                    } else {
                        auth.signOut();
                    }
                }
            }).catch(e => {
                console.error(e);
                alert("Error checking Admin profile.");
                auth.signOut();
            });
        }

        function finishAdminLogin() {
            document.getElementById('admin-shell').style.display = 'flex';
            
            // Update UI to show college code
            const badge = document.querySelector('.admin-brand-badge');
            if (badge) badge.textContent = currentCollegeCode + " ADMIN";

            // Auto-collapse sidebar on mobile
            if (window.innerWidth < 1024) {
                document.querySelector('.sidebar').classList.add('collapsed');
                document.getElementById('sb-toggle-icon').textContent = '▶';
            }
            
            initAdmin();
        }
"""

import re
content = re.sub(
    r"function handleAuthSuccess\(user\) \{[\s\S]*?initAdmin\(\);\s*\}",
    auth_logic,
    content
)

with open('admin.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("Updated admin.html")
