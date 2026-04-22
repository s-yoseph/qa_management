// Copyright (c) 2026, MMCY and contributors
// For license information, please see license.txt

frappe.ui.form.on('QA Checklist', {
    checklist_template: function(frm) {
        if (frm.doc.checklist_template) {
            frappe.call({
                method: "frappe.client.get",
                args: {
                    doctype: "QA Checklist Template",
                    name: frm.doc.checklist_template
                },
                callback: function(r) {
                    if (r.message) {
                        frm.clear_table("checklist_items");

                        r.message.template_items.forEach(item => {
                            let row = frm.add_child("checklist_items");
                            row.test_case_id = item.test_case_id;
                            row.test_description = item.test_description;
                            row.expected_result = item.expected_result;
                        });

                        frm.refresh_field("checklist_items");
                    }
                }
            });
        }
    }
});

// When a new row is added to the checklist_items table, give it a default test_case_id
frappe.ui.form.on('QA Checklist', 'checklist_items_add', function(frm, cdt, cdn) {
    const row = locals[cdt][cdn];
    // If no test_case_id provided, set a simple incremental id (matches row number)
    if (!row.test_case_id) {
        row.test_case_id = String(frm.doc.checklist_items.length);
    }
    // ensure field values are visible/refresh grid
    frm.refresh_field('checklist_items');
});
