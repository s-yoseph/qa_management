// Copyright (c) 2026, MMCY and contributors
// For license information, please see license.txt

frappe.ui.form.on("QA Checklist Template", {
	refresh(frm) {
		if (frm.__module_list_loaded) return;
		frm.__module_list_loaded = true;

		frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Module Def',
				fields: ['name'],
				order_by: 'name asc',
				limit_page_length: 0
			},
			callback: function(r) {
				if (!r || !r.message) return;
				const modules = r.message.map(m => m.name);

				// If the doctype already has a `module` field of type Select, populate its options
				const df = frm.meta.fields.find(f => f.fieldname === 'module');
				if (df) {
					if (df.fieldtype === 'Select') {
						frm.set_df_property('module', 'options', [''].concat(modules).join('\n'));
					} else if (df.fieldtype === 'Link' && df.options === 'Module Def') {
						// Link to Module Def - nothing to do, autocomplete works out of the box
					} else {
						// For other field types, provide a helper button to choose module
						add_module_picker_button(frm, modules);
					}
				} else {
					// If there's no module field, add a helper button so users can choose and we'll
					// attempt to set a `module` value if/when such a field exists or the form is extended.
					add_module_picker_button(frm, modules);
				}
			}
		});
	}
});

function add_module_picker_button(frm, modules) {
	// Avoid adding duplicate buttons
	if (frm.__module_picker_added) return;
	frm.__module_picker_added = true;

	frm.add_custom_button(__('Select Module'), function() {
		const d = new frappe.ui.Dialog({
			title: __('Select Module'),
			fields: [
				{fieldname: 'module_select', label: __('Module'), fieldtype: 'Select', options: modules.join('\n')}
			],
			primary_action_label: __('Set'),
			primary_action(values) {
				if (!values || !values.module_select) {
					frappe.msgprint(__('Please select a module'));
					return;
				}
				// Try to set the standard `module` field if present
				if (frm.doc.hasOwnProperty('module')) {
					frm.set_value('module', values.module_select);
				} else {
					frappe.msgprint(__('Module chosen: {0}. Add a `module` field to the DocType to persist.', [values.module_select]));
				}
				d.hide();
			}
		});

		d.show();
	});
}
